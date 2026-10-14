/* CENC MP4 -> clear MP4, keeping every byte offset unchanged. */
(function (root) {
  'use strict';
  function unwrap(encoded, flag = 0) {
    const s = Uint8Array.from(atob(encoded), c => c.charCodeAt(0)), n = s.length;
    if (n < 3) throw Error('视频解密参数不完整');
    const b = s[0] ^ s[1] ^ s[2], len = b - 48, count = n - b + 47;
    if (len < 1 || len > n - 2 || count < 2 || count + 1 > n) throw Error('不支持的视频加密格式');
    const type = Array.from(s.slice(n - len), c => String.fromCharCode(c ^ s[n-len-2] ^ s[n-len-1])).join('');
    if (type === 'app_v2' || type === 'web_v2') throw Error('此视频使用尚不支持的加密版本，请手动使用NAS模式');
    const out = s.slice(1, count + 1); let a = 0x55, z = 0xfa;
    for (let i = 0; i < count; i++) {
      const c = out[i]; let x = c, y = a;
      if (i & 1) { x = z; y = c; z = a; }
      let pop = 0; for (let p = i; p; p >>>= 1) pop += p & 1;
      out[i] = (z ^ c) + (flag ? 21 + pop : -21 - pop); a = y; z = x;
    }
    const digit = out[0] >= 48 && out[0] <= 57 ? out[0]-48 : out[0] >= 97 && out[0] <= 122 ? out[0]-87 : 256;
    const text = Array.from(out.slice(1, count-digit), c => String.fromCharCode(c)).join('');
    if (!/^[0-9a-f]{32}$/.test(text)) {
      if (!flag) return unwrap(encoded, 1);
      throw Error('视频解密参数不匹配');
    }
    return Uint8Array.from(text.match(/../g), p => parseInt(p, 16));
  }
  async function decrypt(buffer, spade, progress = () => {}) {
    const data = new Uint8Array(buffer), view = new DataView(buffer);
    const u32 = o => { if (o < 0 || o + 4 > data.length) throw Error('视频文件不完整'); return view.getUint32(o); };
    const text = o => String.fromCharCode(...data.subarray(o, o+4));
    const write = (o, value) => [...value].forEach((c,i) => data[o+i] = c.charCodeAt(0));
    function boxes(lo, hi) {
      const out = [];
      while (lo < hi) {
        if (lo + 8 > hi) throw Error('视频文件不完整');
        let size = u32(lo), header = 8;
        if (size === 1) { size = Number(view.getBigUint64(lo+8)); header = 16; }
        if (!size) size = hi-lo;
        if (!Number.isSafeInteger(size) || size < header || lo+size > hi) throw Error('视频文件不完整');
        out.push({type:text(lo+4), start:lo, p:lo+header, end:lo+size}); lo += size;
      }
      return out;
    }
    function find(parent, names) {
      let b = parent;
      for (const name of names) { b = boxes(b.p,b.end).find(x=>x.type===name); if (!b) throw Error('暂不支持此视频封装格式'); }
      return b;
    }
    const top = boxes(0,data.length);
    if (top.some(b=>b.type==='moof')) throw Error('暂不支持分片视频，请手动使用NAS模式');
    const moov = top.find(b=>b.type==='moov');
    if (!moov) throw Error('视频文件缺少索引');
    const key = await crypto.subtle.importKey('raw', unwrap(spade), 'AES-CTR', false, ['decrypt']);
    let encryptedTracks = 0;
    for (const track of boxes(moov.p,moov.end).filter(b=>b.type==='trak')) {
      const handler = text(find(track,['mdia','hdlr']).p+8);
      if (!['vide','soun'].includes(handler)) continue;
      const stbl = find(track,['mdia','minf','stbl']), children = boxes(stbl.p,stbl.end);
      const senc = children.find(b=>b.type==='senc');
      if (!senc) continue;
      const flags = u32(senc.p) & 0xffffff, ivCount = u32(senc.p+4);
      if (flags || !ivCount) throw Error('暂不支持此视频的分段加密格式');
      const ivSize = (senc.end-senc.p-8)/ivCount;
      if (![8,16].includes(ivSize)) throw Error('视频加密索引异常');
      const stsz = find(stbl,['stsz']), count = u32(stsz.p+8), fixed = u32(stsz.p+4);
      if (count !== ivCount || count > 100000) throw Error('视频样本数量异常');
      const sizes = Array.from({length:count},(_,i)=>fixed || u32(stsz.p+12+i*4));
      const offsetBox = children.find(b=>['stco','co64'].includes(b.type));
      if (!offsetBox) throw Error('视频缺少样本偏移');
      const chunkCount = u32(offsetBox.p+4);
      if (chunkCount > count) throw Error('视频样本索引异常');
      const chunks = Array.from({length:chunkCount},(_,i)=>offsetBox.type==='stco' ? u32(offsetBox.p+8+i*4) : Number(view.getBigUint64(offsetBox.p+8+i*8)));
      const stsc = find(stbl,['stsc']), runs = u32(stsc.p+4);
      if (!runs || runs > chunkCount) throw Error('视频样本索引异常');
      const offsets = []; let sample = 0, run = 0;
      for (let c = 0; c < chunks.length; c++) {
        while (run+1 < runs && c+1 >= u32(stsc.p+8+(run+1)*12)) run++;
        const perChunk = u32(stsc.p+12+run*12); let offset = chunks[c];
        if (perChunk > count) throw Error('视频样本索引异常');
        for (let j = 0; j < perChunk && sample < count; j++,sample++) {
          const size = sizes[sample];
          if (!Number.isSafeInteger(offset) || !size || offset < 0 || offset+size > data.length || !top.some(b=>b.type==='mdat' && offset>=b.p && offset+size<=b.end)) throw Error('视频样本超出文件范围');
          offsets.push(offset); offset += size;
        }
      }
      if (offsets.length !== count) throw Error('视频样本索引不完整');
      for (let i = 0; i < count; i += 32) {
        await Promise.all(offsets.slice(i,i+32).map(async (off,j) => {
          const idx=i+j, counter=new Uint8Array(16);
          counter.set(data.subarray(senc.p+8+idx*ivSize,senc.p+8+(idx+1)*ivSize));
          const plain = new Uint8Array(await crypto.subtle.decrypt({name:'AES-CTR',counter,length:128},key,data.subarray(off,off+sizes[idx])));
          if (handler==='vide') {
            let pos=0; const v=new DataView(plain.buffer);
            while(pos+4<=plain.length) { const length=v.getUint32(pos); if (!length || pos+4+length>plain.length) throw Error('视频解密校验失败'); pos+=4+length; }
            if(pos!==plain.length) throw Error('视频解密校验失败');
          }
          data.set(plain,off);
        }));
        progress(Math.min(count,i+32),count);
      }
      const stsd=find(stbl,['stsd']);
      for (const entry of boxes(stsd.p+8,stsd.end)) {
        if (!['encv','enca'].includes(entry.type)) continue;
        const version=entry.type==='enca' ? view.getUint16(entry.p+8) : 0;
        if (version > 1) throw Error('暂不支持此音频格式');
        const start=entry.p+(entry.type==='encv'?78:version===1?44:28);
        const sinf=boxes(start,entry.end).find(b=>b.type==='sinf');
        if (!sinf) throw Error('视频缺少编码信息');
        const frma=find(sinf,['frma']); let codec=text(frma.p);
        if (!['hvc1','hev1','avc1','mp4a'].includes(codec)) throw Error('此视频编码暂不支持设备解密');
        if(codec==='hev1') codec='hvc1';
        write(entry.start+4,codec); write(sinf.start+4,'free');
      }
      for(const box of children.filter(b=>['senc','saiz','saio'].includes(b.type))) write(box.start+4,'free');
      encryptedTracks++;
    }
    if (!encryptedTracks) throw Error('视频中没有可识别的加密轨道');
    return buffer;
  }
  root.DeviceCrypto={unwrap,decrypt};
  if(typeof module!=='undefined') module.exports=root.DeviceCrypto;
})(globalThis);
