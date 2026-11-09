import {check} from './errors.js';

export const MAX_WORKSPACE_IMAGE = 8 << 20;
const formats = new Set(['png','jpeg','webp','gif']);
const geometry=/^[0-9xX+.%!^<>-]{1,64}$/;
const simple=new Set(['-auto-orient','-strip','-flip','-flop','-negate','+repage']);
const validators={
  '-resize':geometry,'-thumbnail':geometry,'-crop':geometry,'-extent':geometry,
  '-rotate':/^[+-]?[0-9]+(?:\.[0-9]+)?$/,'-quality':/^(?:[1-9][0-9]?|100)$/,
  '-blur':/^[0-9.+xX%,-]{1,40}$/,'-sharpen':/^[0-9.+xX%,-]{1,40}$/,
  '-brightness-contrast':/^[0-9.+xX%,-]{1,40}$/,
  '-background':/^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,24})$/,
  '-gravity':/^(NorthWest|North|NorthEast|West|Center|East|SouthWest|South|SouthEast)$/,
  '-colorspace':/^(sRGB|RGB|Gray)$/,
  '-format':/^(?:[^%\x00-\x1f@/\\]|%[whmnb%]){1,128}$/,
};

// This private protocol contains image bytes and option values, never URLs,
// workspace/S3 paths, output prefixes, shell source or controller credentials.
export function workspaceImagePlan(body) {
  check(body && ['convert','identify'].includes(body.tool), 'Invalid image tool');
  check(Object.keys(body).every(k=>['owner','tool','options','input_format','output_format','data'].includes(k)), 'Unknown image fields');
  check(formats.has(body.input_format), 'Unsupported input format');
  check(body.tool==='identify' ? !body.output_format : formats.has(body.output_format), 'Unsupported output format');
  const opts=body.options??[];
  check(Array.isArray(opts)&&opts.length<=64&&opts.every(v=>typeof v==='string')&&opts.join('').length<=8192,'Invalid image options');
  for(let i=0;i<opts.length;i++){
    const k=opts[i];
    if(simple.has(k)){check(body.tool==='convert','Unsupported identify option');continue}
    check(Object.hasOwn(validators,k)&&i+1<opts.length&&validators[k].test(opts[i+1]),'Unsupported image option');
    check(body.tool==='identify' ? k==='-format' : k!=='-format','Unsupported image option');i++;
  }
  check(typeof body.data==='string'&&body.data.length<=Math.ceil(MAX_WORKSPACE_IMAGE/3)*4&&/^[A-Za-z0-9+/]+={0,2}$/.test(body.data),'Invalid image data');
  const data=Buffer.from(body.data,'base64');check(data.length>0&&data.length<=MAX_WORKSPACE_IMAGE,'Image exceeds 8 MiB');
  const input={index:body.tool==='identify'?opts.length:0,key:'private-input',name:'input.'+body.input_format,format:body.input_format,firstFrame:true};
  const argv=body.tool==='identify'?[...opts,null]:[null,...opts,null];
  const output=body.tool==='identify'?null:{index:argv.length-1,name:'result.'+body.output_format,prefix:body.output_format+':'};
  return {data,plan:{tool:body.tool,argv,inputs:[input],output,prefix:'',singleOutput:true,maxOutputBytes:MAX_WORKSPACE_IMAGE,timeout:20000}};
}
