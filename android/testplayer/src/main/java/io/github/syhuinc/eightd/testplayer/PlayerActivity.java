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
                    // A louder 1 kHz tone in both ears sets the auto-scaled meter's
                    // range, so the 440/660 Hz readings stay below its 8-bit ceiling.
                    // Left ear: 440 Hz (voice band) + 7 kHz (highs); right: 660 Hz + 9 kHz.
                    double ref = 0.35 * Math.sin(2 * Math.PI * 1000 * n / RATE);
                    double t = (double) n / RATE;
                    buf[i] = (short) (32767 * (ref + 0.12 * Math.sin(2 * Math.PI * 440 * t) + 0.12 * Math.sin(2 * Math.PI * 7000 * t)));
                    buf[i + 1] = (short) (32767 * (ref + 0.12 * Math.sin(2 * Math.PI * 660 * t) + 0.12 * Math.sin(2 * Math.PI * 9000 * t)));
                }
                track.write(buf, 0, buf.length);
            }
        }, "testplayer");
        player.start();
        new Thread(() -> measure(session), "testplayer-meter").start();
    }

    /**
     * Measures our own output with two visualizers. The one on this session
     * sits before Live 8D's effect in the chain (the emulator showed it is
     * registered first), so it reports the unprocessed sound. The one on the
     * device's final output mix (session 0) hears what is actually played.
     * Each sees a mono mix, but the left tone is 440 Hz and the right one
     * 660 Hz, so their FFT bins tell the ears apart. The final mix is very
     * quiet on the emulator, so it is auto-scaled (NORMALIZED): absolute
     * levels are lost, but the left/right difference, which 8D changes, stays.
     */
    private void measure(int session) {
        Visualizer own = open(session, Visualizer.SCALING_MODE_AS_PLAYED), mix = open(0, Visualizer.SCALING_MODE_NORMALIZED);
        if (own == null && mix == null) return;
        byte[] fft = new byte[Visualizer.getCaptureSizeRange()[1]];
        long t0 = System.nanoTime();
        while (true) {
            try {
                Thread.sleep(250);
            } catch (InterruptedException e) {
                return;
            }
            StringBuilder line = new StringBuilder(String.format("level t=%.2f", (System.nanoTime() - t0) / 1e9));
            for (Object[] v : new Object[][]{{"", own}, {"mix_", mix}}) {
                Visualizer vis = (Visualizer) v[1];
                if (vis == null || vis.getFft(fft) != Visualizer.SUCCESS) continue;
                double rate = vis.getSamplingRate() / 1000.0;
                for (int hz : new int[]{440, 660, 7000, 9000}) {
                    line.append(String.format(" %sf%d=%.1f", v[0], hz, peakDb(fft, hz, fft.length, rate)));
                }
            }
            Log.i(TAG, line.toString());
        }
    }

    private static Visualizer open(int session, int scaling) {
        try {
            Visualizer v = new Visualizer(session);
            v.setCaptureSize(Visualizer.getCaptureSizeRange()[1]);
            v.setScalingMode(scaling);
            v.setEnabled(true);
            return v;
        } catch (RuntimeException e) {
            Log.e(TAG, "visualizer on session " + session + " unavailable: " + e);
            return null;
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
