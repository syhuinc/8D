package io.github.syhuinc.eightd.testplayer;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;

import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * Shares a song with 8D Converter the way a file manager or chat app does:
 * ACTION_SEND with a content:// URI and a one-off read grant. The song is a
 * 6-second stereo WAV (440 Hz left, 660 Hz right) named "shared tones.wav".
 */
public class ShareActivity extends Activity {
    private static final String TAG = "TESTPLAYER";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            writeSong();
            Uri uri = Uri.parse("content://" + SongProvider.AUTHORITY + "/" + Uri.encode(SongProvider.NAME));
            startActivity(new Intent(Intent.ACTION_SEND)
                    .setPackage("io.github.syhuinc.eightd")
                    .setType("audio/wav")
                    .putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
            Log.i(TAG, "shared " + uri);
        } catch (IOException | RuntimeException e) {
            Log.e(TAG, "share failed: " + e);
        }
        finish();
    }

    private void writeSong() throws IOException {
        int rate = 44100, frames = rate * 6;
        ByteBuffer b = ByteBuffer.allocate(44 + frames * 4).order(ByteOrder.LITTLE_ENDIAN);
        b.put("RIFF".getBytes()).putInt(36 + frames * 4).put("WAVE".getBytes());
        b.put("fmt ".getBytes()).putInt(16).putShort((short) 1).putShort((short) 2)
                .putInt(rate).putInt(rate * 4).putShort((short) 4).putShort((short) 16);
        b.put("data".getBytes()).putInt(frames * 4);
        for (int i = 0; i < frames; i++) {
            double t = (double) i / rate;
            b.putShort((short) (8000 * Math.sin(2 * Math.PI * 440 * t)));
            b.putShort((short) (8000 * Math.sin(2 * Math.PI * 660 * t)));
        }
        try (FileOutputStream out = new FileOutputStream(SongProvider.file(this))) {
            out.write(b.array());
        }
    }
}
