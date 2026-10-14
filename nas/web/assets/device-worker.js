'use strict';
importScripts('/ui/assets/device-crypto.js?v=direct-1');
self.onmessage = async event => {
  try {
    const data = await DeviceCrypto.decrypt(event.data.buffer,event.data.spade,(done,total)=>self.postMessage({progress:done/total}));
    self.postMessage({buffer:data},[data]);
  } catch(error) { self.postMessage({error:error.message || '设备解密失败'}); }
};
