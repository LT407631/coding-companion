package net.codingcompanion.tv;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;

/** Grants the system installer read access to exactly one private APK. */
public final class UpdateApkProvider extends ContentProvider {
    static final String AUTHORITY="net.codingcompanion.tv.update";
    static Uri uri() {return Uri.parse("content://"+AUTHORITY+"/apk/current");}
    @Override public boolean onCreate() {return true;}
    private File apk(Uri uri) throws FileNotFoundException {
        if(!uri().equals(uri)) throw new FileNotFoundException();
        File file=new File(getContext().getCacheDir(),"tv-update.apk");
        if(!file.isFile()) throw new FileNotFoundException();
        return file;
    }
    @Override public ParcelFileDescriptor openFile(Uri uri,String mode) throws FileNotFoundException {
        if(!"r".equals(mode)) throw new FileNotFoundException();
        return ParcelFileDescriptor.open(apk(uri),ParcelFileDescriptor.MODE_READ_ONLY);
    }
    @Override public String getType(Uri uri) {return "application/vnd.android.package-archive";}
    @Override public Cursor query(Uri uri,String[] columns,String selection,String[] args,String sort) {
        try {
            File file=apk(uri);String[] names=columns==null?new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE}:columns;
            MatrixCursor cursor=new MatrixCursor(names);Object[] values=new Object[names.length];
            for(int i=0;i<names.length;i++) values[i]=OpenableColumns.DISPLAY_NAME.equals(names[i])?"coding-companion-tv.apk":OpenableColumns.SIZE.equals(names[i])?file.length():null;
            cursor.addRow(values);return cursor;
        } catch(FileNotFoundException e) {return null;}
    }
    @Override public Uri insert(Uri uri,ContentValues values) {throw new UnsupportedOperationException();}
    @Override public int delete(Uri uri,String selection,String[] args) {throw new UnsupportedOperationException();}
    @Override public int update(Uri uri,ContentValues values,String selection,String[] args) {throw new UnsupportedOperationException();}
}
