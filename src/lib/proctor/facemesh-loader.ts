"use client";
declare global { interface Window { FaceMesh?: new (config:{locateFile:(file:string)=>string})=>any } }
let pending:Promise<any>|null=null;
export async function createLocalFaceMesh(maxNumFaces=2):Promise<any>{
 if(typeof window==="undefined")throw new Error("FaceMesh is browser-only");
 if(!pending)pending=new Promise((resolve,reject)=>{if(window.FaceMesh){resolve(window.FaceMesh);return}const existing=document.querySelector<HTMLScriptElement>('script[src="/mediapipe/face_mesh/face_mesh.js"]');const script=existing??document.createElement("script");const done=()=>window.FaceMesh?resolve(window.FaceMesh):reject(new Error("FaceMesh UMD did not register"));script.addEventListener("load",done,{once:true});script.addEventListener("error",()=>reject(new Error("Unable to load local FaceMesh assets")),{once:true});if(!existing){script.src="/mediapipe/face_mesh/face_mesh.js";script.async=true;document.head.appendChild(script)}}).catch(e=>{pending=null;throw e});
 const FaceMesh=await pending;const solution=new FaceMesh({locateFile:(file:string)=>"/mediapipe/face_mesh/"+file});let latest:any=null;solution.onResults((r:any)=>{latest=r});solution.setOptions({maxNumFaces,refineLandmarks:false,minDetectionConfidence:.5,minTrackingConfidence:.5,staticImageMode:false,selfieMode:false});return{solution,getLatest:()=>latest};
}
