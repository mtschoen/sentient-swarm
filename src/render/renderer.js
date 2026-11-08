// Renderer: the warp grid into its own grid layer, then trails decay, spawn gates, glyphs, projectiles, pickups, particles and the ship into the
// current scene target, bloom, then composite (scene plus grid plus bloom) into the swapchain. Two
// rgba16float scene targets at canvas device-pixel size ping-pong for trails. The grid has its own
// rgba16float layer, cleared every frame, so trail decay never copies it forward and it never smears.
//
// Frame contract, its own submission after the simulation's:
//   const encoder = device.createCommandEncoder();
//   renderer.render(encoder, { alpha, time, deltaSeconds, impulses, interpolate }); // deltaSeconds: since the last render
//   device.queue.submit([encoder.finish()]);
//   renderer.afterSubmit(); // maps a pending captureNextFrame readback
// settings are read every frame, so they can be changed live. impulses (optional) are new
// shockwaves { x, y, strength, time, bloomBoost } stamped with the same clock as time; they join
// the renderer's ImpulseSet for the warp grid, and a bloomBoost one doubles bloom strength,
// decaying back over BLOOM_BOOST_SECONDS. sceneTime (optional, time by default) animates the
// projectiles, pickups and ship, which keep real time through a time warp; timeWarp (0 to 1, the
// warp strength) tints the composite cold (owner ruling R31).
import { loadShader, substituteConstants } from '../gpu/shaders.js';
import { SHADER_CONSTANTS } from '../sim/layout.js';
import { BLOOM_DIVISORS, BloomPass } from './bloom.js';
import { FrameCapture } from './capture.js';
import { GateRenderer } from './gates.js';
import { CompositePass } from './composite.js';
import { GlyphPass } from './glyphs.js';
import { ImpulseSet, bloomBoostFactor } from './impulses.js';
import { ParticleRenderer } from './particles.js';
import { PickupRenderer } from './pickups.js';
import { ProjectileRenderer } from './projectiles.js';
import { ShipRenderer } from './ship.js';
import { SCENE_FORMAT, loadFullscreenHeader } from './render-shaders.js';
import { TrailDecayPass, trailFrameFactors } from './trails.js';
import { WarpGrid } from './warpgrid.js';

export const DEFAULT_RENDER_SETTINGS = {
  shipArenaFraction: 0.018,
  // Quad half-size over ship half-length. The Predator plume reaches local x -1.84 (nozzle -0.94
  // plus PLUME_LENGTH 0.9 in glyphs.wgsl), so glowScale must stay at least 2 or the plume clips.
  glowScale: 2,
  // Fraction of the trail kept per 1/60 second. 0.6 (Plan C task C0, owner ruling R2): at 0.9 a
  // full arena smeared into one blur; at 0.6 single ships stay readable with a short streak.
  trailDecay: 0.6,
  bloomStrength: 0.8,
  warpDensityWeight: 0.15,
  warpThreatWeight: 0.6,
  // Multiplier on the composite's BASE_EXPOSURE (composite.js); 1 is the shipped exposure.
  exposure: 1,
};

export class Renderer {
  static async create(gpu, { simulation, viewport }) {
    const [common, fullscreenHeader] = await Promise.all([
      loadShader('common').then((source) => substituteConstants(source, SHADER_CONSTANTS)),
      loadFullscreenHeader(),
    ]);
    const renderer = new Renderer(gpu, { simulation, viewport, common, fullscreenHeader });
    await Promise.all([
      renderer.warpGrid.initialize(),
      renderer.trails.initialize(),
      renderer.gates.initialize(),
      renderer.glyphs.initialize(),
      renderer.particles.initialize(),
      renderer.projectileRenderer.initialize(),
      renderer.pickupRenderer.initialize(),
      renderer.ship.initialize(),
      renderer.bloom.initialize(),
      renderer.composite.initialize(),
    ]);
    renderer.resize(viewport.canvasWidth, viewport.canvasHeight);
    return renderer;
  }

  // Use Renderer.create; the constructor only allocates.
  constructor(gpu, { simulation, viewport, common, fullscreenHeader }) {
    this.gpu = gpu;
    this.device = gpu.device;
    this.simulation = simulation;
    this.viewport = viewport;
    this.settings = { ...DEFAULT_RENDER_SETTINGS };
    this.trails = new TrailDecayPass(gpu, { fullscreenHeader });
    this.warpGrid = new WarpGrid(gpu, { viewport, common });
    this.gates = new GateRenderer(gpu, { viewport, common });
    this.glyphs = new GlyphPass(gpu, { common });
    this.particles = new ParticleRenderer(gpu, { viewport, common });
    this.projectileRenderer = new ProjectileRenderer(gpu, { viewport, common });
    this.pickupRenderer = new PickupRenderer(gpu, { viewport, common });
    this.ship = new ShipRenderer(gpu, { viewport, common });
    this.bloom = new BloomPass(gpu, { fullscreenHeader });
    this.composite = new CompositePass(gpu, { fullscreenHeader });
    this.frameCapture = new FrameCapture(this.device, gpu.format);
    this.impulses = new ImpulseSet();
    this.bloomBoostTime = -Infinity;
    this.sceneTextures = [];
    this.gridTexture = null;
    this.currentIndex = 0;
    this.sizeDevicePixels = [1, 1];
  }

  // Recreates every size-dependent texture; new textures start zeroed, which clears trail history.
  resize(widthDevicePixels, heightDevicePixels) {
    this.destroySceneTextures();
    const size = [Math.max(1, widthDevicePixels), Math.max(1, heightDevicePixels)];
    this.sceneTextures = [0, 1].map((index) => this.device.createTexture({
      label: 'scene-' + index,
      size,
      format: SCENE_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    }));
    this.sizeDevicePixels = size;
    this.sceneViews = this.sceneTextures.map((texture) => texture.createView());
    this.gridTexture = this.device.createTexture({
      label: 'warp-grid-layer',
      size,
      format: SCENE_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.gridView = this.gridTexture.createView();
    this.trails.setSceneTextures(this.sceneTextures);
    this.bloom.resize(this.sceneTextures, this.gridTexture, size[0], size[1]);
    this.composite.setTextures(this.sceneTextures, this.bloom.outputTexture, this.gridTexture);
    this.currentIndex = 0;
  }

  get bloomQuality() { return this.bloom.quality; }

  // 'high', 'medium' or 'low' (BLOOM_DIVISORS); rebuilds only the bloom textures and the
  // composite bind groups, so trails survive. Call between frames.
  setBloomQuality(quality) {
    if (BLOOM_DIVISORS[quality] === undefined) throw new Error(`Unknown bloom quality: ${quality}`);
    if (quality === this.bloom.quality) return;
    this.bloom.quality = quality;
    const [width, height] = this.sizeDevicePixels;
    this.bloom.resize(this.sceneTextures, this.gridTexture, width, height);
    this.composite.setTextures(this.sceneTextures, this.bloom.outputTexture, this.gridTexture);
  }

  // Returns true (the frame was drawn). scene (optional, from the game): { projectiles: Projectiles, pickups: [{ x, y, type, fade }],
  // ship: the ShipRenderer.encode state, or null to hide the ship }. interpolate (half simulation
  // rate): glyphs are drawn between the last two steps at alpha instead of extrapolated from the
  // newest one.
  render(encoder, { alpha, time, sceneTime = time, deltaSeconds = 1 / 60, impulses = [], scene = null, interpolate = false, timeWarp = 0 }) {
    for (const impulse of impulses) {
      this.impulses.add(impulse, impulse.time);
      if (impulse.bloomBoost) this.bloomBoostTime = Math.max(this.bloomBoostTime, impulse.time);
    }
    const previousIndex = this.currentIndex;
    const currentIndex = 1 - previousIndex;
    const { settings, viewport, simulation } = this;
    const gridPass = encoder.beginRenderPass({
      label: 'warp-grid',
      colorAttachments: [{ view: this.gridView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    this.warpGrid.encode(gridPass, simulation.fieldBuffer, time, {
      densityWeight: settings.warpDensityWeight,
      threatWeight: settings.warpThreatWeight,
      impulses: this.impulses.toUniformArray(time),
    });
    gridPass.end();
    const scenePass = encoder.beginRenderPass({
      label: 'scene',
      colorAttachments: [{ view: this.sceneViews[currentIndex], loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    const { decay, emissionScale } = trailFrameFactors(settings.trailDecay, deltaSeconds);
    this.trails.draw(scenePass, previousIndex, decay);
    this.gates.encode(scenePass, simulation, time);
    this.glyphs.draw(scenePass, { simulation, viewport, settings, alpha, time, emissionScale, interpolate });
    if (scene?.projectiles) this.projectileRenderer.encode(scenePass, sceneTime, scene.projectiles);
    if (scene?.pickups) this.pickupRenderer.encode(scenePass, scene.pickups, sceneTime);
    this.particles.encode(scenePass, simulation.particlePool, emissionScale);
    if (scene?.ship) this.ship.encode(scenePass, { ...scene.ship, time: sceneTime });
    scenePass.end();
    this.bloom.encode(encoder, currentIndex);
    const swapchainTexture = this.gpu.context.getCurrentTexture();
    this.composite.encode(encoder, swapchainTexture.createView(), currentIndex, {
      arenaRect: viewport.arenaRectDevicePixels,
      bloomStrength: settings.bloomStrength * bloomBoostFactor(time - this.bloomBoostTime),
      exposure: settings.exposure,
      timeWarp,
    });
    this.frameCapture.encode(encoder, swapchainTexture, { arenaRect: { ...viewport.arenaRectDevicePixels } });
    this.currentIndex = currentIndex;
    return true;
  }

  // Points the renderer at a new Simulation (after commitCapacity). Every pass reads the
  // simulation's buffers at draw time; the bind group caches that hold the old, destroyed buffers
  // are cleared. commitCapacity already built the new simulation's coarse field on the copied
  // agents, so the next frame draws it with the right density attenuation and warp grid.
  setSimulation(simulation) {
    this.simulation = simulation;
    [this.glyphs, this.particles, this.warpGrid].forEach((pass) => pass.bindGroupCache.clear());
  }

  afterSubmit() {
    this.frameCapture.afterSubmit();
  }

  // Resolves with { width, height, format, sourceFormat, pixels, details: { arenaRect } } (RGBA
  // bytes) of the next frame.
  captureNextFrame() {
    return this.frameCapture.request();
  }

  destroySceneTextures() {
    this.sceneTextures.forEach((texture) => texture.destroy());
    this.sceneTextures = [];
    this.gridTexture?.destroy();
    this.gridTexture = null;
  }

  destroy() {
    this.destroySceneTextures();
    [this.glyphs, this.particles, this.warpGrid, this.projectileRenderer].forEach((pass) => pass.bindGroupCache.clear());
    [this.warpGrid, this.trails, this.gates, this.glyphs, this.particles, this.projectileRenderer, this.pickupRenderer, this.ship, this.bloom, this.composite].forEach((pass) => pass.destroy());
    this.frameCapture.destroy();
  }
}
