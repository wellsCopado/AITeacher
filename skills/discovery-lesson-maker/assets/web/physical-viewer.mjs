import * as THREE from 'three';
import { WebGLPathTracer, DenoiseMaterial } from 'three-gpu-pathtracer';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// 渲染器只负责真实网格的光照；不能使错误几何自动写实。
// 本实现固定three 0.186.1 / three-gpu-pathtracer 0.0.27，保留可操作的栅格回退。
export const createPhysicalViewer = (renderer, scene, camera, report = () => {}) => {
  let tracer = null;
  let enabled = false;
  let error = null;
  let lastReported = 0;
  let activeRenderer='raster';
  let updating=false;
  let rebuildTimer=null;
  const denoise=new FullScreenQuad(new DenoiseMaterial({sigma:1.6,kSigma:1.8,threshold:.16}));
  const raster = () => renderer.render(scene, camera);
  const prepare = async () => {
    try {
      if (!renderer.capabilities.isWebGL2 || !renderer.extensions.has('EXT_color_buffer_float')) {
        throw new Error('当前设备缺少所需浮点渲染能力');
      }
      tracer = new WebGLPathTracer(renderer);
      tracer.bounces = 3;
      tracer.transmissiveBounces = 3;
      tracer.renderScale = 1;
      tracer.tiles.set(2, 2);
      tracer.minSamples = 3;
      tracer.renderDelay = 180;
      tracer.dynamicLowRes = false;
      tracer.rasterizeScene = true;
      tracer.textureSize.set(1024,1024);
      tracer.filterGlossyFactor = .45;
      tracer.renderToCanvasCallback=(target,output)=>{denoise.material.map=target.texture;denoise.render(output);};
      tracer.setScene(scene, camera);
      enabled = true;
      report({state:'ready',renderer:'path-tracing',samples:0});
      return true;
    } catch (caught) {
      error = caught.message;
      enabled = false;
      report({state:'fallback',renderer:'raster',reason:error,samples:0});
      return false;
    }
  };
  return {
    prepare,
    reset: () => { if (tracer) tracer.updateCamera(); },
    setEnabled: (value) => { enabled = Boolean(value && tracer && !error); if(enabled)tracer.reset(); },
    updateScene: () => {
      if(!tracer || error)return;
      updating=true;
      clearTimeout(rebuildTimer);
      // 先让点击、镜头与快速画面响应；连续切换只采集最后一次场景。
      rebuildTimer=setTimeout(()=>{
        try{tracer.setScene(scene,camera);}
        catch(caught){enabled=false;error=caught.message;report({state:'fallback',renderer:'raster',reason:error,samples:0});}
        finally{updating=false;rebuildTimer=null;}
      },900);
    },
    render: (moving = false) => {
      if (!enabled || !tracer || moving || updating) { activeRenderer='raster';raster(); return; }
      try {
        activeRenderer='path-tracing';
        if (tracer.samples < 256) tracer.renderSample();
        const count = Math.floor(tracer.samples);
        if (count !== lastReported) {lastReported=count;report({state:'ready',renderer:'path-tracing',samples:count});}
      } catch(caught) {
        enabled=false;error=caught.message;
        activeRenderer='raster';report({state:'fallback',renderer:'raster',reason:error,samples:0});raster();
      }
    },
    getState: () => ({renderer:activeRenderer,enabled,updating,samples:tracer?.samples||0,error}),
    dispose: () => {clearTimeout(rebuildTimer);tracer?.dispose();denoise.dispose();}
  };
};
