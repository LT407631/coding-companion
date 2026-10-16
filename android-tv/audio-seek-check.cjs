// Exercise the maintained epoch-reset and clock code against a delayed vendor head reset.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const source=fs.readFileSync(path.join(__dirname,'src/net/codingcompanion/tv/TclHardwarePlayer.java'),'utf8');
const audio=source.slice(source.indexOf('    private void audio(){'));
const reset=audio.slice(audio.indexOf('                if(epoch!=generation){'),audio.indexOf('                eos=feed('));
const position=source.slice(source.indexOf('    private long position(){'),source.indexOf('    @Override public int getCurrentPosition()'));
const out=path.join(__dirname,'build/audio-seek-check');fs.mkdirSync(out,{recursive:true});
const java=`class AudioSeekCheck {
 static boolean vendor=true;
 static class RedmiPlayback {static boolean applies(){return vendor;}}
 static class SystemClock {static long elapsedRealtime(){return 0;}}
 static class AudioTrack {int head;boolean released;AudioTrack(int h){head=h;}int getPlaybackHeadPosition(){if(released)throw new IllegalStateException();return head;}void pause(){}void flush(){if(!vendor)head=0;}void release(){released=true;}}
 static class MediaExtractor {static final int SEEK_TO_PREVIOUS_SYNC=0;long seek;long getSampleTime(){return seek;}void seekTo(long pts,int mode){seek=pts;}}
 static class Codec {void flush(){}}
 AudioTrack audio,pending;Object audioInput=new Object();Codec codec=new Codec();MediaExtractor extractor=new MediaExtractor();
 int epoch=0,generation=1,target=3000,seekTarget,duration=30000,audioRate=48000;boolean landing,recovered;long inputMs;long audioBase=-1,audioEpoch=-1,wallPosition,wall,written;float speed=1;boolean playing=true,eos;void note(String value){}
 ${position}
 void reset(){AudioTrack track=audio;${reset}pending=track;}
 void firstSample(){audio=pending==null?new AudioTrack(0):pending;audioBase=target;audioEpoch=generation;}
 static void require(boolean b,String m){if(!b)throw new AssertionError(m);}
 static void scenario(int requested){AudioSeekCheck h=new AudioSeekCheck();h.target=requested;AudioTrack old=new AudioTrack(480000);h.audio=old;h.reset();h.firstSample();require(h.position()==requested,"old 10-second playback head pulled seek "+requested+" back to "+h.position());require(old.released,"vendor output released before fresh clock");require(h.extractor.seek==requested*1000L,"extractor also seeks exact target");h.audio.head=24000;require(h.position()==requested+500,"fresh head advances from requested point");}
 public static void main(String[] args){scenario(3000);scenario(20000);scenario(0);vendor=false;AudioSeekCheck h=new AudioSeekCheck();AudioTrack old=new AudioTrack(480000);h.audio=old;h.reset();h.firstSample();require(h.audio==old&&!old.released&&h.position()==3000,"existing TCL flush route retained");System.out.println("PASS: production clock/epoch code with delayed vendor head reset; backward/forward/zero seek stay at target, fresh clock progresses, TCL reset retained.");}
}`;
const file=path.join(out,'AudioSeekCheck.java');fs.writeFileSync(file,java);
for(const [bin,args]of [['javac',['--release','8','-d',out,file]],['java',['-cp',out,'AudioSeekCheck']]]){const r=cp.spawnSync('/opt/homebrew/opt/openjdk@21/bin/'+bin,args,{encoding:'utf8'});process.stdout.write(r.stdout||'');if(r.status)throw new Error(r.stderr);}
