package net.codingcompanion.tv;

import android.app.Activity;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import java.io.*;
import java.net.*;
import java.security.SecureRandom;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.*;

/** TCL keeps the ordinary OEM HTTP player; only authenticated transport runs in the app. */
final class TclMediaSource {
    interface Report {void status(String note);}
    static final class Input implements Closeable {
        private static final int BUFFER=16*1024;
        private static final Pattern REQUEST_RANGE=Pattern.compile("bytes=([0-9]{1,18})-([0-9]{0,18})");
        private static final Pattern RESPONSE_RANGE=Pattern.compile("bytes ([0-9]{1,18})-([0-9]{1,18})/([0-9]{1,18})");
        private final URL url;
        private final String path;
        private final ServerSocket server;
        private final Report report;
        private final java.util.concurrent.atomic.AtomicBoolean statusReported=new java.util.concurrent.atomic.AtomicBoolean();
        private final AtomicInteger errors=new AtomicInteger();
        private final Set<Socket> clients=Collections.newSetFromMap(new ConcurrentHashMap<Socket,Boolean>());
        private final Set<HttpURLConnection> upstream=Collections.newSetFromMap(new ConcurrentHashMap<HttpURLConnection,Boolean>());
        private final ThreadPoolExecutor workers=new ThreadPoolExecutor(0,2,1,TimeUnit.SECONDS,new SynchronousQueue<Runnable>(),r->{Thread t=new Thread(r,"tcl-http-read");t.setDaemon(true);return t;});
        private volatile String cookie, mediaTicket;
        private volatile boolean closed;
        Input(String address,String session,Report report)throws IOException{this(address,session,null,report);}
        Input(String address,String session,String ticket,Report report)throws IOException{
            url=new URL(address);
            if(!("http".equals(url.getProtocol())||"https".equals(url.getProtocol()))||url.getUserInfo()!=null||url.getRef()!=null||!"/stream".equals(url.getPath()))throw new IOException("Invalid media address");
            cookie=session;mediaTicket=ticket;this.report=report;
            byte[] key=new byte[16];new SecureRandom().nextBytes(key);StringBuilder text=new StringBuilder("/");for(byte b:key)text.append(String.format(Locale.ROOT,"%02x",b&255));path=text.toString()+"/video.mp4";
            server=new ServerSocket(0,2,InetAddress.getByName("127.0.0.1"));
            Thread listener=new Thread(()->{
                while(!closed){Socket client=null;try{
                    client=server.accept();client.setSoTimeout(2000);clients.add(client);
                    if(closed){client.close();clients.remove(client);break;}
                    final Socket accepted=client;workers.execute(()->serve(accepted));
                }catch(IOException|RejectedExecutionException ignored){if(client!=null){clients.remove(client);try{client.close();}catch(IOException e){}}}}
            },"tcl-http-listen");listener.setDaemon(true);listener.start();
        }
        void ticket(String value){mediaTicket=value;}
        String address(){return "http://127.0.0.1:"+server.getLocalPort()+path;}
        private void note(String text){if(!closed&&report!=null&&(text.startsWith("status=")?statusReported.compareAndSet(false,true):errors.getAndIncrement()<2))report.status("transport=local-http,"+text);}
        private static String line(InputStream input,int[] budget)throws IOException{
            ByteArrayOutputStream out=new ByteArrayOutputStream();int b;
            while((b=input.read())!=-1){if(--budget[0]<0)throw new IOException("HTTP headers too large");if(b=='\n')break;if(b!='\r')out.write(b);}
            if(b==-1)throw new IOException("HTTP request closed");return out.toString("US-ASCII");
        }
        private static void response(OutputStream output,int status,String headers)throws IOException{
            String reason=status==200?"OK":status==206?"Partial Content":status==401?"Unauthorized":"Request Failed";
            output.write(("HTTP/1.1 "+status+" "+reason+"\r\nConnection: close\r\n"+headers+"\r\n").getBytes("US-ASCII"));output.flush();
        }
        private void serve(Socket client){
            HttpURLConnection c=null;boolean sent=false;String stage="client";
            try{Socket socket=client;
                InputStream request=new BufferedInputStream(socket.getInputStream(),1024);OutputStream output=socket.getOutputStream();int[] budget={8192};String[] first=line(request,budget).split(" ");
                if(first.length!=3||!path.equals(first[1])||!("GET".equals(first[0])||"HEAD".equals(first[0]))){response(output,404,"Content-Length: 0\r\n");return;}
                String range=null,header;
                while(!(header=line(request,budget)).isEmpty())if(header.regionMatches(true,0,"Range:",0,6)){if(range!=null)throw new IOException("Duplicate range");range=header.substring(6).trim();}
                long wanted=-1,end=-1;
                if(range!=null){Matcher r=REQUEST_RANGE.matcher(range);if(!r.matches()){response(output,416,"Content-Length: 0\r\n");return;}wanted=Long.parseLong(r.group(1));if(!r.group(2).isEmpty()){end=Long.parseLong(r.group(2));if(end<wanted){response(output,416,"Content-Length: 0\r\n");return;}}}
                if(closed)return;c=(HttpURLConnection)url.openConnection();upstream.add(c);
                c.setInstanceFollowRedirects(false);c.setConnectTimeout(5000);c.setReadTimeout(8000);c.setRequestProperty("Accept-Encoding","identity");c.setRequestProperty("User-Agent","CodingCompanionTV/1.0.30");
                String session=cookie,ticket=mediaTicket;if(session!=null)c.setRequestProperty("Cookie",session);if(ticket!=null&&!ticket.isEmpty())c.setRequestProperty("X-Coding-Media",ticket);if(range!=null)c.setRequestProperty("Range",range);
                if(closed)return;stage="upstream";int status=c.getResponseCode();String type=c.getContentType(),contentRange=c.getHeaderField("Content-Range"),size=c.getHeaderField("Content-Length");
                note("status="+status+",type="+type+",range="+contentRange);
                if(status!=200&&status!=206){response(output,status>=300&&status<400?502:status,"Content-Length: 0\r\n");return;}
                if(type==null||!type.toLowerCase(Locale.ROOT).startsWith("video/mp4")||size==null||!size.matches("[0-9]{1,18}")||(range!=null&&status!=206))throw new IOException("Invalid media response");
                long remaining=Long.parseLong(size);String headers="Content-Type: video/mp4\r\nAccept-Ranges: bytes\r\nContent-Length: "+size+"\r\n";
                if(status==206){Matcher r=RESPONSE_RANGE.matcher(String.valueOf(contentRange));if(!r.matches())throw new IOException("Invalid media range");long a=Long.parseLong(r.group(1)),b=Long.parseLong(r.group(2)),total=Long.parseLong(r.group(3));if(a<0||b<a||total<=b||b-a+1!=remaining||(wanted>=0&&a!=wanted)||(end>=0&&b>end))throw new IOException("Invalid media range");headers+="Content-Range: "+contentRange+"\r\n";}
                stage="client";response(output,status,headers);sent=true;
                if(!"HEAD".equals(first[0]))try(InputStream media=c.getInputStream()){
                    byte[] buffer=new byte[BUFFER];while(!closed&&remaining>0){stage="upstream";int n=media.read(buffer,0,(int)Math.min(buffer.length,remaining));if(n<0)throw new IOException("Truncated media");stage="client";output.write(buffer,0,n);remaining-=n;}
                }
            }catch(IOException|RuntimeException e){if("upstream".equals(stage))note("upstream-error="+e.getClass().getSimpleName());if(!sent&&!closed)try{response(client.getOutputStream(),502,"Content-Length: 0\r\n");}catch(IOException ignored){}}
            finally{if(c!=null){upstream.remove(c);c.disconnect();}clients.remove(client);try{client.close();}catch(IOException ignored){}}
        }
        @Override public void close(){closed=true;cookie=null;mediaTicket=null;try{server.close();}catch(IOException ignored){}for(Socket c:clients)try{c.close();}catch(IOException ignored){}for(HttpURLConnection c:upstream)c.disconnect();workers.shutdownNow();}
    }
    private static final class Player extends MediaPlayer {
        private Input input;
        void source(Activity activity,String url,Map<String,String> headers,Report report)throws IOException{
            if(input!=null)input.close();input=new Input(url,headers.get("Cookie"),headers.get("X-Coding-Media"),report);
            try{setDataSource(activity,Uri.parse(input.address()),Collections.<String,String>emptyMap());}catch(IOException|RuntimeException e){input.close();input=null;throw e;}
        }
        @Override public void release(){if(input!=null){input.close();input=null;}super.release();}
        @Override public void reset(){if(input!=null){input.close();input=null;}super.reset();}
    }
    static boolean localTransport(){
        String maker=Build.MANUFACTURER==null?"":Build.MANUFACTURER.toLowerCase(Locale.ROOT);
        String model=Build.MODEL==null?"":Build.MODEL.toLowerCase(Locale.ROOT);
        return TvCompatibility.applies(Build.MODEL)||maker.equals("xiaomi")||maker.equals("redmi")||model.startsWith("mitv")||model.startsWith("redmi");
    }
    static boolean ticketTransport(){return localTransport()&&!TvCompatibility.applies(Build.MODEL);}
    static void ticket(MediaPlayer player,String value){if(player instanceof TclHardwarePlayer)((TclHardwarePlayer)player).ticket(value);else if(player instanceof Player&&((Player)player).input!=null)((Player)player).input.ticket(value);}
    static MediaPlayer create(){return localTransport()?new Player():new MediaPlayer();}
    static MediaPlayer createHardware(){
        if(!(TvCompatibility.applies(Build.MODEL)&&Build.VERSION.SDK_INT>=29)&&!RedmiPlayback.applies())throw new IllegalStateException("TCL hardware route unavailable");
        return new TclHardwarePlayer();
    }
    static void set(MediaPlayer player,Activity activity,String url,Map<String,String> headers,Report report)throws IOException{
        if(player instanceof TclHardwarePlayer)((TclHardwarePlayer)player).source(url,headers,report);
        else if(player instanceof Player)((Player)player).source(activity,url,headers,report);
        else player.setDataSource(activity,Uri.parse(url),headers);
    }
}
