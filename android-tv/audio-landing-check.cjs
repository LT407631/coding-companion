// Run the maintained audio loop with OEMs that keep old data after a seek.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const s=fs.readFileSync(path.join(__dirname,'src/net/codingcompanion/tv/TclHardwarePlayer.java'),'utf8');
let begin=s.indexOf('    private MediaCodec audioCodec(');if(begin<0)begin=s.indexOf('    private void audio(){');
const loop=s.slice(begin,s.indexOf('    private synchronized void completeIfEnded()'));
const out=path.join(__dirname,'build/audio-landing-check');fs.mkdirSync(out,{recursive:true});
const java=`import java.util.*;import java.nio.*;import java.io.*;
class AudioLandingCheck {
 static AudioLandingCheck owner;static String mode;static boolean vendor=true;static int codecs,extractors,liveCodecs,maxCodecs,releases,writes;static long readInput;
 static class RedmiPlayback{static boolean applies(){return vendor;}}
 static class Input{String address(){return "http://127.0.0.1/stream";}}
 static class MediaFormat{static final String KEY_MIME="mime",KEY_CHANNEL_COUNT="channels";String getString(String s){return "audio/mp4a-latm";}int getInteger(String s){return 2;}}
 static class MediaExtractor{static final int SEEK_TO_PREVIOUS_SYNC=0;long pts;boolean old,dead;MediaExtractor(){old=++extractors==1;}void setDataSource(String s,Map<String,String> h)throws IOException{if(mode.equals("open-failure"))throw new IOException("fixture source unavailable");}void selectTrack(int i){}long getSampleTime(){return pts*1000;}void seekTo(long n,int mode){if(!(old&&AudioLandingCheck.mode.equals("extractor")&&n/1000<pts))pts=n/1000;}void release(){require(!dead,"double extractor release");dead=true;}}
 static class MediaCodec{
  static final int INFO_OUTPUT_FORMAT_CHANGED=-2,BUFFER_FLAG_END_OF_STREAM=4;boolean stale,dead,first;long sample;int id;
  static class BufferInfo{int flags,size=4,offset;long presentationTimeUs;}
  static class CodecException extends RuntimeException{String getDiagnosticInfo(){return "fixture";}}
  static MediaCodec createDecoderByType(String mime){MediaCodec c=new MediaCodec();c.id=++codecs;liveCodecs++;maxCodecs=Math.max(maxCodecs,liveCodecs);return c;}
  void configure(MediaFormat f,Object a,Object b,int n){}void start(){}void flush(){if(id==1&&(mode.equals("codec")||mode.equals("persistent")||mode.equals("open-failure")))stale=true;}
  int dequeueOutputBuffer(BufferInfo b,int timeout){b.size=4;b.presentationTimeUs=(sample+(stale||(id>1&&mode.equals("persistent"))?10000:0))*1000;return 0;}
  MediaFormat getOutputFormat(){return new MediaFormat();}ByteBuffer getOutputBuffer(int n){return ByteBuffer.allocate(4);}void releaseOutputBuffer(int n,boolean render){}
  void release(){require(!dead,"double codec release");dead=true;liveCodecs--;releases++;}
 }
 static class AudioTrack{int head;boolean dead;void pause(){}void play(){}void flush(){head=0;}int getPlaybackHeadPosition(){return head;}void release(){require(!dead,"double track release");dead=true;}static final int WRITE_NON_BLOCKING=1;
  int write(ByteBuffer b,int n,int mode){b.position(b.limit());head+=1024;writes++;
   if(owner.generation==0&&writes==3){owner.target=3000;owner.generation=1;owner.audioBase=-1;owner.audioEpoch=-1;}
   else if(owner.generation==1){require(owner.audioBase>=3000&&owner.audioBase<3500,"old audio was accepted as new seek clock: "+owner.audioBase);owner.closed=true;}
   return n;
  }}
 Input input=new Input();MediaExtractor audioInput=new MediaExtractor();MediaFormat audioFormat=new MediaFormat();AudioTrack audio;boolean closed,playing=true,audioDone,errorSeen;int target=12000,generation;long audioBase=-1,audioEpoch=-1;List<String> notes=new ArrayList<>();
 boolean awaitPlaying(){return !closed;}void error(){errorSeen=true;closed=true;}void completeIfEnded(){}void note(String s){notes.add(s);}int track(MediaExtractor e,String type){return 0;}AudioTrack sink(MediaFormat f){return new AudioTrack();}
 static boolean feed(MediaCodec c,MediaExtractor e,boolean eos){readInput=e.pts;c.sample=e.pts;e.pts+=21;return false;}
 ${loop}
 static void failure(String kind){mode=kind;vendor=true;codecs=extractors=liveCodecs=maxCodecs=releases=writes=0;owner=new AudioLandingCheck();owner.audio();require(owner.errorSeen&&owner.closed,"bad landing must fail visibly");require(codecs<3&&liveCodecs==0&&maxCodecs==1,"bounded failed recovery releases codecs");require(writes==3,"wrong PCM never played");}
 static void require(boolean b,String msg){if(!b)throw new AssertionError(msg);}
 static void scenario(String kind,boolean redmi){mode=kind;vendor=redmi;codecs=extractors=liveCodecs=maxCodecs=releases=writes=0;owner=new AudioLandingCheck();owner.audio();require(owner.closed,"audio did not finish test");require(liveCodecs==0&&maxCodecs==1,"one audio codec and full release");require(codecs==(redmi&&!kind.equals("normal")?2:1),"bounded recovery count "+kind+"/"+codecs+"/"+owner.notes);require(owner.audio==null,"sink cleared");if(redmi&&!kind.equals("normal"))require(owner.notes.toString().contains("method=cold-reopen"),"recovery is diagnosed");}
 public static void main(String[] a){scenario("codec",true);scenario("extractor",true);scenario("normal",true);scenario("normal",false);failure("persistent");failure("open-failure");System.out.println("PASS: production audio loop rejects old PCM, reopens codec/extractor once, validates fresh timestamp, one decoder, release, normal Redmi and TCL preserved");}
}`;
const f=path.join(out,'AudioLandingCheck.java');fs.writeFileSync(f,java);
for(const [bin,args] of [['javac',['--release','8','-d',out,f]],['java',['-cp',out,'AudioLandingCheck']]]){let r=cp.spawnSync('/opt/homebrew/opt/openjdk@21/bin/'+bin,args,{encoding:'utf8',timeout:10000});process.stdout.write(r.stdout||'');if(r.status!==0)throw new Error(r.stderr||String(r.error));}
