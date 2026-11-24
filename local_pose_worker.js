importScripts("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/vision_bundle.js");

const VISION_WASM="https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm";
const POSE_MODEL="https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const {FilesetResolver,PoseLandmarker}=self.Vision;
let landmarker=null;

async function initialize() {
  const fileset=await FilesetResolver.forVisionTasks(VISION_WASM);
  const options={
    baseOptions:{modelAssetPath:POSE_MODEL,delegate:"GPU"},
    runningMode:"VIDEO",
    numPoses:1,
    minPoseDetectionConfidence:0.5,
    minPosePresenceConfidence:0.5,
    minTrackingConfidence:0.5,
  };
  try {
    landmarker=await PoseLandmarker.createFromOptions(fileset,options);
  } catch(gpuError) {
    console.warn("MediaPipe GPU delegate indisponível; tentando execução CPU.",gpuError);
    try {
      options.baseOptions.delegate="CPU";
      landmarker=await PoseLandmarker.createFromOptions(fileset,options);
    } catch(cpuError) {
      throw new Error(`Não foi possível iniciar a pose no aparelho. GPU: ${gpuError.message}. CPU: ${cpuError.message}`);
    }
  }
}

self.onmessage=async event=>{
  const message=event.data;
  if(message.type==="init") {
    try {
      await initialize();
      self.postMessage({type:"ready"});
    } catch(error) {
      self.postMessage({type:"error",message:error.message});
    }
    return;
  }
  if(message.type==="frame"&&landmarker) {
    const frame=message.frame;
    try {
      const result=landmarker.detectForVideo(frame,message.timestamp);
      self.postMessage({
        type:"result",
        landmarks:result.landmarks?.[0]||null,
        worldLandmarks:result.worldLandmarks?.[0]||null,
      });
    } catch(error) {
      self.postMessage({type:"error",message:`Falha ao analisar um frame: ${error.message}`});
    } finally {
      frame.close();
    }
  }
  if(message.type==="close") {
    landmarker?.close();
    landmarker=null;
    self.close();
  }
};
