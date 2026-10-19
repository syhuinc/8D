package io.github.syhuinc.eightd.testplayer;

import android.app.Activity;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.media.audiofx.AudioEffect;
import android.media.audiofx.Visualizer;
import android.os.Bundle;
import android.util.Log;

public class PlayerActivity extends Activity {
    private static final String TAG = "TESTPLAYER";
    private static final int RATE = 48000;
    private static volatile Thread player;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (player != null) return;
        AudioTrack track = new AudioTrack.Builder()
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
                .setAudioFormat(new AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(RATE)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO).build())
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build();
        int session = track.getAudioSessionId();
        Log.i(TAG, "session=" + session);
        // What music apps do so equaliser apps can process their audio.
        sendBroadcast(new Intent(AudioEffect.ACTION_OPEN_AUDIO_EFFECT_CONTROL_SESSION)
                .putExtra(AudioEffect.EXTRA_AUDIO_SESSION, session)
                .putExtra(AudioEffect.EXTRA_PACKAGE_NAME, getPackageName())
                .putExtra(AudioEffect.EXTRA_CONTENT_TYPE, AudioEffect.CONTENT_TYPE_MUSIC));

        player = new Thread(() -> {
            track.play();
            short[] buf = new short[2 * 960];
            long n = 0;
            while (true) {
                for (int i = 0; i < buf.length; i += 2, n++) {
                    buf[i] = (short) (0.3 * 32767 * Math.sin(2 * Math.PI * 440 * n / RATE));
                    buf[i + 1] = (short) (0.3 * 32767 * Math.sin(2 * Math.PI * 660 * n / RATE));
                }
                track.write(buf, 0, buf.length);
            }
        }, "testplayer");
        player.start();
        new Thread(() -> measure(session), "testplayer-meter").start();
    }

    /**
     * The visualizer sits at the end of this session's effect chain, after
     * any effect Live 8D attaches. It sees a mono mix, but the left tone is
     * 440 Hz and the right one 660 Hz, so their FFT bins tell the ears apart.
     */
    private void measure(int session) {
        Visualizer v;
        try {
            v = new Visualizer(session);
            v.setCaptureSize(Visualizer.getCaptureSizeRange()[1]);
            v.setScalingMode(Visualizer.SCALING_MODE_AS_PLAYED);
            v.setEnabled(true);
        } catch (RuntimeException e) {
            Log.e(TAG, "visualizer unavailable: " + e);
            return;
        }
        int size = v.getCaptureSize();
        double rate = v.getSamplingRate() / 1000.0;
        byte[] fft = new byte[size];
        long t0 = System.nanoTime();
        while (true) {
            try {
                Thread.sleep(250);
            } catch (InterruptedException e) {
                return;
            }
            if (v.getFft(fft) != Visualizer.SUCCESS) continue;
            Log.i(TAG, String.format("level t=%.2f left440=%.1f right660=%.1f",
                    (System.nanoTime() - t0) / 1e9, peakDb(fft, 440, size, rate), peakDb(fft, 660, size, rate)));
        }
    }

    /** Strongest bin within ±2 bins of the frequency, in dB. */
    private static double peakDb(byte[] fft, double hz, int size, double rate) {
        int center = (int) Math.round(hz * size / rate);
        double best = 0;
        for (int k = Math.max(1, center - 2); k <= Math.min(size / 2 - 1, center + 2); k++) {
            double re = fft[2 * k], im = fft[2 * k + 1];
            best = Math.max(best, Math.hypot(re, im));
        }
        return 20 * Math.log10(best + 1e-3);
    }
}
