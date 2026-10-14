package net.codingcompanion.tv;

import java.net.URI;
import java.util.Set;

/** Pure validation shared by release checks and the final install gate. */
final class UpdatePolicy {
    static final String PACKAGE="net.codingcompanion.tv";
    static final long MAX_BYTES=128L*1024*1024;
    static URI origin(String site) throws Exception {
        URI u=new URI(site);
        if(u.getHost()==null || u.getUserInfo()!=null || u.getQuery()!=null || u.getFragment()!=null) throw new Exception("网站地址无效");
        String host=u.getHost();
        boolean local=host.matches("(127|10)\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}") || host.matches("192\\.168\\.\\d{1,3}\\.\\d{1,3}") || host.matches("172\\.(1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}");
        if(!"https".equals(u.getScheme()) && !("http".equals(u.getScheme())&&local)) throw new Exception("外网更新需要 HTTPS 地址，请修改连接设置");
        return new URI(u.getScheme(),null,u.getHost(),u.getPort(),null,null,null);
    }
    static int port(URI u) {return u.getPort()<0?("https".equals(u.getScheme())?443:80):u.getPort();}
    static URI download(String site,String value,String hash) throws Exception {
        URI base=origin(site),url=base.resolve(new URI(value));
        if(!base.getScheme().equals(url.getScheme()) || !base.getHost().equalsIgnoreCase(url.getHost()) || port(base)!=port(url) || url.getUserInfo()!=null || url.getQuery()!=null || url.getFragment()!=null || !url.getRawPath().equals("/updates/android-tv/"+hash+".apk")) throw new Exception("更新下载地址不属于当前 NAS");
        return url;
    }
    static boolean newer(String pkg,int version,int minSdk,long size,String hash,int installed,int sdk) throws Exception {
        if(!PACKAGE.equals(pkg) || version<=0 || minSdk<=0 || size<=0 || size>MAX_BYTES || hash==null || !hash.matches("[0-9a-f]{64}")) throw new Exception("更新信息无效");
        if(version<=installed) return false;
        if(minSdk>sdk) throw new Exception("新版需要更高的 Android 系统，当前设备不能安装");
        return true;
    }
    static void archive(String pkg,int version,int expected,Set<String> installed,Set<String> candidate) throws Exception {
        if(!PACKAGE.equals(pkg) || version!=expected || installed.isEmpty() || !installed.equals(candidate)) throw new Exception("安装包身份或签名不匹配，已停止安装");
    }
}
