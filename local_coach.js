(() => {
  const THREE_MODULE = "https://cdn.jsdelivr.net/npm/three@0.174.0/build/three.module.js";
  const FBX_LOADER_MODULE = "https://cdn.jsdelivr.net/npm/three@0.174.0/examples/jsm/loaders/FBXLoader.js";
  const CONNECTIONS = [
    [11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],
    [23,25],[25,27],[24,26],[26,28],[27,29],[29,31],[28,30],[30,32],
  ];
  const EXERCISE_THRESHOLDS = {
    squat: {down:105, up:158, joints:[[23,25,27],[24,26,28]]},
    pushup: {down:92, up:155, joints:[[11,13,15],[12,14,16]]},
    bicep_curl: {down:55, up:145, joints:[[11,13,15],[12,14,16]]},
    lunge: {down:105, up:158, joints:[[23,25,27],[24,26,28]]},
  };

  function pointVisible(point) {
    return point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
      (point.visibility === undefined || point.visibility >= 0.45);
  }

  function angleAt(a, b, c) {
    if (!pointVisible(a) || !pointVisible(b) || !pointVisible(c)) return null;
    const abx=a.x-b.x, aby=a.y-b.y, cbx=c.x-b.x, cby=c.y-b.y;
    const denominator=Math.hypot(abx,aby)*Math.hypot(cbx,cby);
    if (denominator < 1e-8) return null;
    const cosine=Math.max(-1,Math.min(1,(abx*cbx+aby*cby)/denominator));
    return Math.acos(cosine)*180/Math.PI;
  }

  class FitVersoLocalCoach {
    constructor({video,cameraCanvas,avatarCanvas,exercise,onFrame,onSnapshot,onError}) {
      this.video=video;
      this.cameraCanvas=cameraCanvas;
      this.avatarCanvas=avatarCanvas;
      this.exercise=exercise;
      this.onFrame=onFrame;
      this.onSnapshot=onSnapshot;
      this.onError=onError;
      this.running=false;
      this.paused=false;
      this.worker=null;
      this.inferenceInFlight=false;
      this.avatar=null;
      this.raf=0;
      this.lastVideoTime=-1;
      this.lastInferenceAt=0;
      this.lastTimestamp=0;
      this.lastSnapshotAt=0;
      this.previousFrameAt=0;
      this.startedAt=0;
      this.fps=0;
      this.currentLandmarks=null;
      this.smoothedLandmarks=null;
      this.lastPoseUpdateAt=0;
      this.reps=Object.fromEntries(Object.keys(EXERCISE_THRESHOLDS).map(key=>[key,0]));
      this.phases=Object.fromEntries(Object.keys(EXERCISE_THRESHOLDS).map(key=>[key,"up"]));
      this.hasReportedFrameError=false;
    }

    async start() {
      if(typeof createImageBitmap!=="function") {
        throw new Error("Este navegador não oferece createImageBitmap para processar a pose local.");
      }
      this.worker=new Worker("/local_pose_worker.js");
      this.worker.onmessage=event=>{
        const message=event.data;
        if(message.type==="ready") {
          this.workerReadyResolve?.();
        } else if(message.type==="result") {
          this.inferenceInFlight=false;
          this.processResult(message,performance.now());
        } else if(message.type==="error") {
          this.inferenceInFlight=false;
          const error=new Error(message.message);
          if(!this.running) this.workerReadyReject?.(error);
          else if(!this.hasReportedFrameError) {
            this.hasReportedFrameError=true;
            this.onError(error);
          }
        }
      };
      this.worker.onerror=event=>{
        const error=new Error(event.message||"Falha no worker de pose.");
        if(!this.running) this.workerReadyReject?.(error);
        else if(!this.hasReportedFrameError) {
          this.hasReportedFrameError=true;
          this.onError(error);
        }
      };
      const workerReady=new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error("Tempo esgotado ao carregar a pose local.")),120000);
        this.workerReadyReject=error=>{clearTimeout(timer);reject(error);};
        this.workerReadyResolve=()=>{clearTimeout(timer);resolve();};
      });
      this.worker.postMessage({type:"init"});
      try {
        const [THREE]=await Promise.all([import(THREE_MODULE),workerReady]);
        this.avatar=new AvatarRenderer(THREE,this.avatarCanvas);
        try {
          const {FBXLoader}=await import(FBX_LOADER_MODULE);
          await this.avatar.loadXBot("/assets/x-bot.fbx",FBXLoader);
        } catch(error) {
          this.onError(new Error(`Não foi possível carregar o avatar X Bot: ${error.message}`));
        }
        this.startedAt=performance.now();
        this.running=true;
        this.tick();
      } finally {
        this.workerReadyReject=null;
        this.workerReadyResolve=null;
      }
    }

    tick=()=>{
      if(!this.running) return;
      const now=performance.now();
      if(this.video.readyState>=2 && this.video.currentTime!==this.lastVideoTime) {
        this.drawCamera(this.currentLandmarks);
        if(!this.paused && !this.inferenceInFlight && now-this.lastInferenceAt>=33) {
          this.lastVideoTime=this.video.currentTime;
          this.lastInferenceAt=now;
          const timestamp=Math.max(now,this.lastTimestamp+1);
          this.lastTimestamp=timestamp;
          this.inferenceInFlight=true;
          createImageBitmap(this.video).then(bitmap=>{
            if(!this.running||!this.worker) {bitmap.close();this.inferenceInFlight=false;return;}
            this.worker.postMessage({type:"frame",frame:bitmap,timestamp},[bitmap]);
          }).catch(error=>{
            this.inferenceInFlight=false;
            if(!this.hasReportedFrameError) {
              this.hasReportedFrameError=true;
              this.onError(new Error(`Não foi possível preparar um frame para a pose local: ${error.message}`));
            }
          });
        }
      }
      if(this.avatar) this.avatar.render();
      this.raf=requestAnimationFrame(this.tick);
    };

    smoothLandmarks(landmarks,now) {
      if(!landmarks) {
        this.smoothedLandmarks=null;
        this.lastPoseUpdateAt=now;
        return null;
      }

      const previous=this.smoothedLandmarks;
      const deltaSeconds=this.lastPoseUpdateAt
        ?Math.min((now-this.lastPoseUpdateAt)/1000,0.2)
        :0;
      const smoothed=landmarks.map((point,index)=>{
        const prior=previous?.[index];
        if(!pointVisible(point)||!pointVisible(prior)||deltaSeconds<=0) return point?{...point}:point;
        const speed=Math.hypot(point.x-prior.x,point.y-prior.y)/deltaSeconds;
        const alpha=Math.min(0.9,0.38+speed*0.18);
        const priorZ=prior.z||0,pointZ=point.z||0;
        return {
          ...point,
          x:prior.x+(point.x-prior.x)*alpha,
          y:prior.y+(point.y-prior.y)*alpha,
          z:priorZ+(pointZ-priorZ)*alpha,
        };
      });
      this.smoothedLandmarks=smoothed;
      this.lastPoseUpdateAt=now;
      return smoothed;
    }

    processResult(result,now) {
      const landmarks=this.smoothLandmarks(result.landmarks||null,now);
      const world=result.worldLandmarks||null;
      this.currentLandmarks=landmarks;
      if(landmarks) {
        this.drawCamera(landmarks);
        this.avatar.update(landmarks,world);
      } else {
        this.drawCamera(landmarks);
        this.avatar.update([],[]);
      }

      const angles=landmarks?this.exerciseAngle(landmarks):[];
      const visibleAngles=angles.filter(Number.isFinite);
      const angle=visibleAngles.length
        ? visibleAngles.reduce((sum,value)=>sum+value,0)/visibleAngles.length
        : null;
      if(angle!==null) this.updateCounter(angle);

      const delta=this.previousFrameAt?Math.max((now-this.previousFrameAt)/1000,1e-3):0;
      this.fps=delta?(this.fps?0.85*this.fps+0.15/delta:1/delta):0;
      this.previousFrameAt=now;
      const info={
        reps:this.reps[this.exercise]||0,
        reps_by_exercise:{...this.reps},
        angle:angle===null?null:Math.round(angle*10)/10,
        feedback:this.feedback(angle),
        fps:Math.round(this.fps),
        elapsed_seconds:Math.floor((now-this.startedAt)/1000),
        person_detected:Boolean(landmarks),
      };
      this.onFrame(info);
      if(landmarks && this.onSnapshot && now-this.lastSnapshotAt>=1000) {
        this.lastSnapshotAt=now;
        const worldPoints=world?.length===landmarks.length
          ?world
          :landmarks.map(point=>({x:point.x,y:point.y,z:point.z||0}));
        this.onSnapshot({
          timestamp_seconds:Math.max(0,(now-this.startedAt)/1000),
          exercise:this.exercise,
          reps:info.reps,
          angle_degrees:info.angle,
          joints_2d:landmarks.map(point=>[point.x,point.y]),
          joints_3d_cam:worldPoints.map(point=>[point.x,point.y,point.z]),
        });
      }
    }

    exerciseAngle(landmarks) {
      const spec=EXERCISE_THRESHOLDS[this.exercise];
      if(!spec) return [];
      const values=spec.joints.map(([a,b,c])=>angleAt(landmarks[a],landmarks[b],landmarks[c]));
      const valid=values.filter(Number.isFinite);
      if(this.exercise==="lunge"||this.exercise==="squat") return valid.length?[Math.min(...valid)]:[];
      return valid;
    }

    updateCounter(angle) {
      const spec=EXERCISE_THRESHOLDS[this.exercise];
      if(angle<=spec.down) this.phases[this.exercise]="down";
      else if(angle>=spec.up && this.phases[this.exercise]==="down") {
        this.reps[this.exercise]++;
        this.phases[this.exercise]="up";
      }
    }

    feedback(angle) {
      if(angle===null) return "Fique visível para a câmera";
      if(this.exercise==="squat"||this.exercise==="lunge") {
        if(angle>120) return "Desça com controle";
        if(angle<55) return "Suba com controle";
      } else if(this.exercise==="pushup") {
        if(angle>120) return "Desça mantendo o corpo alinhado";
        if(angle<45) return "Suba sem travar os cotovelos";
      } else if(this.exercise==="bicep_curl") {
        if(angle>115) return "Flexione o cotovelo sem balançar";
        if(angle<40) return "Estenda o braço com controle";
      }
      return "Boa forma · mantenha o controle";
    }

    drawCamera(landmarks) {
      const canvas=this.cameraCanvas,video=this.video;
      if(canvas.width!==video.videoWidth||canvas.height!==video.videoHeight) {
        canvas.width=video.videoWidth;canvas.height=video.videoHeight;
      }
      const context=canvas.getContext("2d");
      context.clearRect(0,0,canvas.width,canvas.height);
      const mirrored=document.getElementById("facingMode").value==="user";
      context.save();
      if(mirrored) {context.translate(canvas.width,0);context.scale(-1,1);}
      context.drawImage(video,0,0,canvas.width,canvas.height);
      if(landmarks) {
        context.lineWidth=Math.max(3,canvas.width/220);
        context.strokeStyle="#66e0c3";
        context.fillStyle="#f5fffc";
        for(const [a,b] of CONNECTIONS) {
          if(!pointVisible(landmarks[a])||!pointVisible(landmarks[b])) continue;
          context.beginPath();
          context.moveTo(landmarks[a].x*canvas.width,landmarks[a].y*canvas.height);
          context.lineTo(landmarks[b].x*canvas.width,landmarks[b].y*canvas.height);
          context.stroke();
        }
        for(const point of landmarks) {
          if(!pointVisible(point)) continue;
          context.beginPath();
          context.arc(point.x*canvas.width,point.y*canvas.height,Math.max(3,canvas.width/150),0,Math.PI*2);
          context.fill();
        }
      }
      context.restore();
    }

    setExercise(exercise) {
      if(!Object.prototype.hasOwnProperty.call(EXERCISE_THRESHOLDS,exercise)) return;
      this.exercise=exercise;
    }

    setPaused(paused) {
      this.paused=paused;
    }

    reset() {
      this.reps[this.exercise]=0;
      this.phases[this.exercise]="up";
    }

    stop() {
      this.running=false;
      cancelAnimationFrame(this.raf);
      this.worker?.terminate();
      this.avatar?.dispose();
      this.worker=null;
      this.avatar=null;
    }
  }

  class AvatarRenderer {
    constructor(THREE,canvas) {
      this.THREE=THREE;
      this.canvas=canvas;
      this.scene=new THREE.Scene();
      this.scene.background=new THREE.Color("#202a33");
      this.camera=new THREE.OrthographicCamera(-1.7,1.7,2.2,-2.2,0.1,50);
      this.camera.position.set(0,0,8);
      this.cameraFocus=new THREE.Vector3();
      this.hasCameraFocus=false;
      this.renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false});
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.5));
      this.renderer.setClearColor("#202a33",1);
      this.scene.add(new THREE.HemisphereLight("#ffffff","#52616b",2.0));
      const light=new THREE.DirectionalLight("#ffffff",2.2);
      light.position.set(-3,5,7);this.scene.add(light);
      this.material=new THREE.MeshStandardMaterial({color:"#61c8b3",roughness:0.48,metalness:0.04});
      this.jointMaterial=new THREE.MeshStandardMaterial({color:"#e5fff7",roughness:0.4});
      this.limbMaterial=new THREE.MeshStandardMaterial({color:"#4e9f9b",roughness:0.52});
      this.fallbackObjects=[];
      this.segments=new Map();
      this.joints=new Map();
      this.avatarRoot=null;
      this.rigBones=[];
      this.rigBoneSpecs=[
        ["Spine","Spine1","hips","shoulders"],
        ["Spine1","Spine2","hips","shoulders"],
        ["Spine2","Neck","hips","shoulders"],
        ["Neck","Head","shoulders","nose"],
        ["Head","HeadTop_End","shoulders","nose"],
        ["LeftShoulder","LeftArm","shoulders","leftShoulder"],
        ["LeftArm","LeftForeArm","leftShoulder","leftElbow"],
        ["LeftForeArm","LeftHand","leftElbow","leftWrist"],
        ["LeftHand","LeftHandIndex1","leftWrist","leftHandTip"],
        ["RightShoulder","RightArm","shoulders","rightShoulder"],
        ["RightArm","RightForeArm","rightShoulder","rightElbow"],
        ["RightForeArm","RightHand","rightElbow","rightWrist"],
        ["RightHand","RightHandIndex1","rightWrist","rightHandTip"],
        ["LeftUpLeg","LeftLeg","leftHip","leftKnee"],
        ["LeftLeg","LeftFoot","leftKnee","leftAnkle"],
        ["LeftFoot","LeftToeBase","leftAnkle","leftToe"],
        ["RightUpLeg","RightLeg","rightHip","rightKnee"],
        ["RightLeg","RightFoot","rightKnee","rightAnkle"],
        ["RightFoot","RightToeBase","rightAnkle","rightToe"],
      ];
      this.torso=this.createEllipsoid();
      this.pelvis=this.createEllipsoid();
      this.head=this.createJoint(0.16);
      this.segment("neck",0.075,this.material);
      for(const [name,radius,material] of [
        ["leftUpperArm",0.072,this.material],["leftForearm",0.055,this.limbMaterial],
        ["rightUpperArm",0.072,this.material],["rightForearm",0.055,this.limbMaterial],
        ["leftThigh",0.105,this.material],["leftShin",0.075,this.limbMaterial],
        ["rightThigh",0.105,this.material],["rightShin",0.075,this.limbMaterial],
      ]) this.segment(name,radius,material);
      for(const index of [11,12,13,14,15,16,23,24,25,26,27,28]) this.joints.set(index,this.createJoint(index>=23?0.09:0.075));
      this.started=true;
      this.resize();
    }

    async loadXBot(url,FBXLoader) {
      const model=await new FBXLoader().loadAsync(url);
      model.updateMatrixWorld(true);
      const bounds=new this.THREE.Box3().setFromObject(model);
      const size=bounds.getSize(new this.THREE.Vector3());
      if(!Number.isFinite(size.y)||size.y<=0) throw new Error("O arquivo não contém uma malha 3D com altura válida.");

      this.modelBaseScale=2.8/size.y;
      const center=bounds.getCenter(new this.THREE.Vector3());
      model.scale.setScalar(this.modelBaseScale);
      model.position.copy(center).multiplyScalar(-this.modelBaseScale);
      this.scene.add(model);
      model.updateMatrixWorld(true);

      const bones=new Map();
      const normalizeBoneName=name=>name.replace(/^mixamorig:?/i,"");
      const hasDistinctBoneChild=bone=>bone.children.some(child=>
        child.isBone&&normalizeBoneName(child.name)!==normalizeBoneName(bone.name)
      );
      model.traverse(object=>{
        if(object.isBone) {
          const name=normalizeBoneName(object.name);
          const current=bones.get(name);
          if(!current||(!hasDistinctBoneChild(current)&&hasDistinctBoneChild(object))) bones.set(name,object);
        }
        if(object.isMesh) {
          object.castShadow=true;
          object.receiveShadow=true;
          object.frustumCulled=false;
        }
      });
      const requiredNames=new Set(["Hips",...this.rigBoneSpecs.flatMap(([bone,child])=>[bone,child])]);
      const missing=[...requiredNames].filter(name=>!bones.has(name));
      if(missing.length) throw new Error(`O rig X Bot está sem estes ossos: ${missing.join(", ")}.`);

      const hips=bones.get("Hips");
      this.hipsRestLocal=model.worldToLocal(hips.getWorldPosition(new this.THREE.Vector3()));
      this.modelBaseQuaternion=model.quaternion.clone();
      this.rigBones=this.rigBoneSpecs.map(([boneName,childName,from,to])=>{
        const bone=bones.get(boneName);
        const child=bones.get(childName);
        const bonePosition=bone.getWorldPosition(new this.THREE.Vector3());
        const childPosition=child.getWorldPosition(new this.THREE.Vector3());
        const restDirection=childPosition.sub(bonePosition).normalize();
        if(restDirection.lengthSq()<1e-8) throw new Error(`O osso ${boneName} não tem direção inicial válida.`);
        return {
          bone,
          from,
          to,
          restDirection,
          restWorldQuaternion:bone.getWorldQuaternion(new this.THREE.Quaternion()),
        };
      });
      this.avatarRoot=model;
      this.avatarRoot.visible=false;
      for(const object of this.fallbackObjects) object.visible=false;
    }

    createEllipsoid() {
      const mesh=new this.THREE.Mesh(new this.THREE.SphereGeometry(1,18,14),this.material);
      this.scene.add(mesh);this.fallbackObjects.push(mesh);return mesh;
    }

    createJoint(radius) {
      const mesh=new this.THREE.Mesh(new this.THREE.SphereGeometry(radius,14,12),this.jointMaterial);
      this.scene.add(mesh);this.fallbackObjects.push(mesh);return mesh;
    }

    segment(name,radius,material) {
      const mesh=new this.THREE.Mesh(new this.THREE.CylinderGeometry(radius*0.86,radius,1,12),material);
      this.scene.add(mesh);this.fallbackObjects.push(mesh);this.segments.set(name,mesh);return mesh;
    }

    point(landmarks,index) {
      const source=landmarks[index];
      if(!pointVisible(source)) return null;
      return new this.THREE.Vector3((source.x-0.5)*2.15,(0.5-source.y)*3.05,-(source.z||0)*0.45);
    }

    center(a,b) {
      if(!a&&!b) return null;
      if(!a) return b.clone();
      if(!b) return a.clone();
      return a.clone().add(b).multiplyScalar(0.5);
    }

    setSegment(name,a,b) {
      const mesh=this.segments.get(name);
      if(!mesh||!a||!b) {if(mesh) mesh.visible=false;return null;}
      const direction=b.clone().sub(a),length=direction.length();
      if(length<0.015) {mesh.visible=false;return null;}
      mesh.visible=true;mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(new this.THREE.Vector3(0,1,0),direction.normalize());
      mesh.scale.set(1,length,1);
      return length;
    }

    setEllipsoid(mesh,a,b,widthScale,depth) {
      if(!a||!b) {mesh.visible=false;return;}
      const direction=b.clone().sub(a),length=direction.length();
      mesh.visible=length>0.015;
      if(!mesh.visible) return;
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(new this.THREE.Vector3(0,1,0),direction.clone().normalize());
      mesh.scale.set(widthScale,length*0.62,depth);
    }

    update(landmarks,worldLandmarks) {
      if(this.avatarRoot) {
        this.updateXBot(landmarks,worldLandmarks);
        return;
      }
      const p=index=>this.point(landmarks,index);
      const leftShoulder=p(11),rightShoulder=p(12),leftHip=p(23),rightHip=p(24);
      const shoulders=this.center(leftShoulder,rightShoulder),hips=this.center(leftHip,rightHip),nose=p(0);
      const shoulderWidth=leftShoulder&&rightShoulder?leftShoulder.distanceTo(rightShoulder):0.48;
      const hipWidth=leftHip&&rightHip?leftHip.distanceTo(rightHip):0.35;
      this.setEllipsoid(this.torso,shoulders,hips,Math.max(0.2,shoulderWidth*0.56),0.19);
      this.setEllipsoid(this.pelvis,hips,hips?hips.clone().add(new this.THREE.Vector3(0,-0.23,0)):null,Math.max(0.18,hipWidth*0.62),0.2);
      const headCenter=nose|| (shoulders?shoulders.clone().add(new this.THREE.Vector3(0,0.27,0)):null);
      if(headCenter) {this.head.visible=true;this.head.position.copy(headCenter);}
      else this.head.visible=false;
      this.setSegment("neck",shoulders,headCenter);
      this.setSegment("leftUpperArm",leftShoulder,p(13));
      this.setSegment("leftForearm",p(13),p(15));
      this.setSegment("rightUpperArm",rightShoulder,p(14));
      this.setSegment("rightForearm",p(14),p(16));
      this.setSegment("leftThigh",leftHip,p(25));
      this.setSegment("leftShin",p(25),p(27));
      this.setSegment("rightThigh",rightHip,p(26));
      this.setSegment("rightShin",p(26),p(28));
      for(const [index,mesh] of this.joints) {
        const position=p(index);
        mesh.visible=Boolean(position);
        if(position) mesh.position.copy(position);
      }
    }

    updateXBot(landmarks,worldLandmarks) {
      const p=index=>this.point(landmarks,index);
      const leftShoulder=p(11),rightShoulder=p(12);
      const leftHip=p(23),rightHip=p(24);
      const targets={
        hips:this.center(leftHip,rightHip),
        shoulders:this.center(leftShoulder,rightShoulder),
        nose:p(0),
        leftShoulder,
        leftElbow:p(13),
        leftWrist:p(15),
        leftHandTip:this.center(p(19),p(17)),
        rightShoulder,
        rightElbow:p(14),
        rightWrist:p(16),
        rightHandTip:this.center(p(20),p(18)),
        leftHip,
        leftKnee:p(25),
        leftAnkle:p(27),
        leftToe:this.center(p(31),p(29)),
        rightHip,
        rightKnee:p(26),
        rightAnkle:p(28),
        rightToe:this.center(p(32),p(30)),
      };
      if(!targets.hips||!targets.shoulders) {
        this.avatarRoot.visible=false;
        return;
      }

      this.avatarRoot.visible=true;
      const feet=this.center(targets.leftAnkle,targets.rightAnkle);
      const head=targets.nose||targets.shoulders.clone().add(new this.THREE.Vector3(0,0.25,0));
      const poseHeight=feet?Math.abs(head.y-feet.y):2.8;
      const scaleFactor=Math.max(0.55,Math.min(1.3,poseHeight/2.8));
      const scale=this.modelBaseScale*scaleFactor;
      this.avatarRoot.scale.setScalar(scale);
      const hipsOffset=this.hipsRestLocal.clone().multiplyScalar(scale)
        .applyQuaternion(this.modelBaseQuaternion);
      this.avatarRoot.position.copy(targets.hips).sub(hipsOffset);
      this.avatarRoot.updateMatrixWorld(true);

      for(const entry of this.rigBones) {
        const start=targets[entry.from],end=targets[entry.to];
        if(!start||!end) continue;
        const targetDirection=end.clone().sub(start);
        if(targetDirection.lengthSq()<1e-8) continue;
        targetDirection.normalize();
        const worldDelta=new this.THREE.Quaternion()
          .setFromUnitVectors(entry.restDirection,targetDirection);
        const desiredWorld=worldDelta.multiply(entry.restWorldQuaternion);
        const parentWorld=entry.bone.parent.getWorldQuaternion(new this.THREE.Quaternion());
        const desiredLocal=parentWorld.invert().multiply(desiredWorld);
        entry.bone.quaternion.slerp(desiredLocal,0.42);
        entry.bone.updateWorldMatrix(true,false);
      }
      this.avatarRoot.updateMatrixWorld(true);
    }

    resize() {
      const width=Math.max(1,this.canvas.clientWidth),height=Math.max(1,this.canvas.clientHeight);
      const aspect=width/height;
      this.camera.left=-2.2*aspect;this.camera.right=2.2*aspect;
      this.camera.top=2.2;this.camera.bottom=-2.2;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width,height,false);
    }

    render() {
      if(!this.started) return;
      const width=this.canvas.clientWidth,height=this.canvas.clientHeight;
      if(width!==this.lastWidth||height!==this.lastHeight) {
        this.lastWidth=width;this.lastHeight=height;this.resize();
      }
      if(this.avatarRoot?.visible) {
        if(!this.hasCameraFocus) {
          this.cameraFocus.copy(this.avatarRoot.position);
          this.hasCameraFocus=true;
        } else {
          this.cameraFocus.lerp(this.avatarRoot.position,0.12);
        }
        this.camera.position.set(this.cameraFocus.x,this.cameraFocus.y,this.cameraFocus.z+8);
        this.camera.lookAt(this.cameraFocus);
      }
      this.renderer.render(this.scene,this.camera);
    }

    dispose() {
      this.started=false;
      this.renderer.dispose();
      this.scene.traverse(object=>{
        if(object.geometry) object.geometry.dispose();
        if(object.material) {
          if(Array.isArray(object.material)) object.material.forEach(material=>material.dispose());
          else object.material.dispose();
        }
      });
    }
  }

  FitVersoLocalCoach.angleAt=angleAt;
  window.FitVersoLocalCoach=FitVersoLocalCoach;
})();
