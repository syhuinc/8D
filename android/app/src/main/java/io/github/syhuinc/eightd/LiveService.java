package io.github.syhuinc.eightd;

import android.annotation.TargetApi;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.media.audiofx.AudioEffect;
import android.media.audiofx.DynamicsProcessing;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Live 8D for other apps.
 *
 * Music apps announce their audio session so equaliser apps can process it
 * (AudioEffect.ACTION_OPEN_AUDIO_EFFECT_CONTROL_SESSION). We attach Android's
 * DynamicsProcessing effect to each announced session and animate it: the far
 * ear gets quieter and slightly muffled (head shadow), and sound behind the
 * listener gets duller. Nothing is captured or re-played, so there is no extra
 * latency and no permission beyond MODIFY_AUDIO_SETTINGS.
 *
 * Limits: the effect works per ear, so it can't move sound from one ear to the
 * other (a hard-left instrument fades rather than travels), and it can't keep
 * vocals centred. Apps that never announce their session are not reached.
 */
@TargetApi(28) // DynamicsProcessing
public class LiveService extends Service {
    static final String TAG = "8DLIVE";
    static final String ACTION_STOP = "io.github.syhuinc.eightd.live.STOP";
    private static final int NOTIFICATION_ID = 8;
    private static final int PRIORITY = 1000; // above typical equaliser apps, so our changes take effect
    private static final long FRAME_MS = 40;  // 25 updates per second
    // Three bands per ear: bass, the voice range, and highs. With "Keep vocals
    // in the center" on, only bass and highs move; the voice band stays equal
    // in both ears, so the voice stays in the middle.
    private static final float BASS_TOP = 200f, VOICE_TOP = 5000f, HIGH_TOP = 20000f;
    private static final int ALL_AUDIO = 0; // the device's output mix ("Process all audio")

    private static volatile LiveService instance;

    private final Map<Integer, Attached> sessions = new LinkedHashMap<>();
    private Handler main;
    private long startedAt;
    private long settingsReadAt;
    private double period = 8;  // seconds per circle, from the shared settings
    private double depth = 1;   // effect strength 0..1
    private boolean keepVocals = true; // shared "Keep vocals in the center" setting
    private boolean allAudio;          // shared "Process all audio" setting
    private int frames;
    private boolean debugLog; // per-second effect diagnostics, debug builds only

    // What Live 8D saw recently, shown in the app so problems can be diagnosed on the phone.
    private static final ArrayDeque<String> events = new ArrayDeque<>();

    private static void event(String text) {
        Log.i(TAG, text);
        synchronized (events) {
            events.addFirst(new SimpleDateFormat("HH:mm:ss", Locale.US).format(new Date()) + "  " + text);
            while (events.size() > 15) events.removeLast();
        }
    }

    private static final class Attached {
        final String packageName;
        final DynamicsProcessing effect;

        Attached(String packageName, DynamicsProcessing effect) {
            this.packageName = packageName;
            this.effect = effect;
        }
    }

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            int session = intent.getIntExtra(AudioEffect.EXTRA_AUDIO_SESSION, AudioEffect.ERROR);
            String pkg = intent.getStringExtra(AudioEffect.EXTRA_PACKAGE_NAME);
            boolean open = AudioEffect.ACTION_OPEN_AUDIO_EFFECT_CONTROL_SESSION.equals(intent.getAction());
            event((open ? "announced: " : "closed: ") + name(pkg) + " (session " + session + ")");
            if (session <= 0) return;
            if (!open) detach(session);
            else if (allAudio) event("  not attached separately: \"Process all audio\" is on");
            else attach(session, pkg);
        }
    };

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        main = new Handler(Looper.getMainLooper());
        debugLog = (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, buildNotification());
        }
        IntentFilter filter = new IntentFilter();
        filter.addAction(AudioEffect.ACTION_OPEN_AUDIO_EFFECT_CONTROL_SESSION);
        filter.addAction(AudioEffect.ACTION_CLOSE_AUDIO_EFFECT_CONTROL_SESSION);
        // Exported: these broadcasts come from other apps. Older Android ignores the flag.
        registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
        startedAt = System.nanoTime();
        readSettings(startedAt);
        event("Live 8D started" + (allAudio ? " (all audio)" : "") + ". Now press play in your music app.");
        main.post(this::frame);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) stopSelf();
        return START_NOT_STICKY;
    }

    private void attach(int session, String pkg) {
        if (sessions.containsKey(session)) return;
        try {
            DynamicsProcessing.Eq eq = new DynamicsProcessing.Eq(true, true, 3);
            eq.setBand(0, new DynamicsProcessing.EqBand(true, BASS_TOP, 0f));
            eq.setBand(1, new DynamicsProcessing.EqBand(true, VOICE_TOP, 0f));
            eq.setBand(2, new DynamicsProcessing.EqBand(true, HIGH_TOP, 0f));
            DynamicsProcessing.Config config = new DynamicsProcessing.Config.Builder(
                    DynamicsProcessing.VARIANT_FAVOR_FREQUENCY_RESOLUTION, 2,
                    true, 3, false, 0, false, 0, false)
                    .setPreEqAllChannelsTo(eq)
                    .build();
            DynamicsProcessing effect = new DynamicsProcessing(PRIORITY, session, config);
            effect.setEnabled(true);
            sessions.put(session, new Attached(pkg, effect));
            event("  attached to " + name(pkg) + (effect.hasControl() ? "" : " (another effect app has control!)"));
        } catch (RuntimeException e) {
            event("  could not attach to " + name(pkg) + ": " + e.getMessage());
        }
    }

    private void detach(int session) {
        Attached a = sessions.remove(session);
        if (a == null) return;
        a.effect.release();
        event("  released " + name(a.packageName));
    }

    private static String name(String pkg) {
        if (pkg == null || pkg.isEmpty()) return "an app";
        switch (pkg) {
            case "all audio": return "all audio";
            case "com.apple.android.music": return "Apple Music";
            case "com.spotify.music": return "Spotify";
            case "com.google.android.apps.youtube.music": return "YouTube Music";
            default: return pkg;
        }
    }

    /** "Process all audio": one effect on the device's output mix, for apps that don't announce. */
    private void setAllAudio(boolean on) {
        if (on == allAudio) return;
        allAudio = on;
        for (Integer session : sessions.keySet().toArray(new Integer[0])) detach(session);
        if (on) {
            event("Process all audio: on");
            attach(ALL_AUDIO, "all audio");
            if (!sessions.containsKey(ALL_AUDIO)) event("  this phone doesn't allow it; turn it off and use apps that connect");
        } else {
            event("Process all audio: off. Press play again so your music app reconnects.");
        }
    }

    /** One animation step: place the sound on the circle for the current time. */
    private void frame() {
        if (instance != this) return;
        long now = System.nanoTime();
        if (now - settingsReadAt > 2_000_000_000L) readSettings(now);
        double angle = 2 * Math.PI * ((now - startedAt) / 1e9) / period; // 0 = front, then right, back, left
        double x = Math.sin(angle);  // +1 right, -1 left
        double z = Math.cos(angle);  // +1 front, -1 back
        // Per-ear volume alone sounds like a left-right swing, so the circle is
        // made audible with front/back contrast: clear in front, muffled and a
        // little quieter behind. The sides stay moderate (12 dB) so the sound
        // never feels stuck in one ear. Gains only ever go down: some phones'
        // effects may reject boosts.
        float ild = (float) (12 * depth);    // level difference at the sides (dB)
        float shadow = (float) (8 * depth);  // extra treble cut in the far ear at the sides (dB)
        float behind = (float) Math.max(0, -z);
        float muffle = (float) (-12 * depth * behind); // highs behind the head
        float dip = (float) (-2.5 * depth * behind);   // a little quieter behind
        float[] side = {(float) Math.max(0, x), (float) Math.max(0, -x)}; // how far each ear is the far one
        float[] input = new float[2], bass = new float[2], voice = new float[2], high = new float[2];
        for (int ch = 0; ch < 2; ch++) {
            float far = -ild * side[ch];
            if (keepVocals) { // move bass and highs; the voice band stays put
                input[ch] = 0;
                bass[ch] = far + dip;
                voice[ch] = 0;
                high[ch] = far - shadow * side[ch] + muffle + dip;
            } else {          // move everything
                input[ch] = far + dip;
                bass[ch] = 0;
                voice[ch] = 0;
                high[ch] = -shadow * side[ch] + muffle;
            }
        }
        for (Integer session : sessions.keySet().toArray(new Integer[0])) {
            DynamicsProcessing dp = sessions.get(session).effect;
            try {
                for (int ch = 0; ch < 2; ch++) {
                    dp.setInputGainbyChannel(ch, input[ch]);
                    dp.setPreEqBandByChannelIndex(ch, 0, new DynamicsProcessing.EqBand(true, BASS_TOP, bass[ch]));
                    dp.setPreEqBandByChannelIndex(ch, 1, new DynamicsProcessing.EqBand(true, VOICE_TOP, voice[ch]));
                    dp.setPreEqBandByChannelIndex(ch, 2, new DynamicsProcessing.EqBand(true, HIGH_TOP, high[ch]));
                }
                if (debugLog && frames % 25 == 0) {
                    Log.d(TAG, String.format("session %d: control=%b keepVocals=%b bass L/R=%.1f/%.1f high L/R=%.1f/%.1f input L/R=%.1f/%.1f",
                            session, dp.hasControl(), keepVocals, bass[0], bass[1], high[0], high[1], input[0], input[1]));
                }
            } catch (RuntimeException e) { // session ended, or another app took control
                event("  lost " + name(sessions.get(session).packageName) + ": " + e.getMessage());
                detach(session);
            }
        }
        frames++;
        main.postDelayed(this::frame, FRAME_MS);
    }

    /** Orbit time and effect strength come from the same saved settings as the converter. */
    private void readSettings(long now) {
        settingsReadAt = now;
        String json = getSharedPreferences("settings", MODE_PRIVATE).getString("json", "");
        try {
            JSONObject s = new JSONObject(json.isEmpty() ? "{}" : json);
            double newPeriod = Math.max(2, Math.min(20, s.optDouble("period", 8)));
            if (newPeriod != period) {
                // Keep the current position when the speed changes, so the sound doesn't jump.
                double elapsed = (now - startedAt) / 1e9;
                startedAt = now - (long) (elapsed / period * newPeriod * 1e9);
                period = newPeriod;
            }
            depth = Math.max(0, Math.min(1, s.optDouble("strength", 1)));
            keepVocals = s.optBoolean("vocals", true);
            setAllAudio(s.optBoolean("liveAll", false));
        } catch (JSONException ignored) {
        }
    }

    /** For the page: whether live mode is on and which apps it is processing. */
    static String statusJson() {
        LiveService s = instance;
        JSONObject o = new JSONObject();
        JSONArray apps = new JSONArray();
        try {
            o.put("running", s != null);
            if (s != null) {
                for (Attached a : s.sessions.values()) apps.put(a.packageName == null ? "" : a.packageName);
            }
            o.put("apps", apps);
            JSONArray log = new JSONArray();
            synchronized (events) {
                for (String e : events) log.put(e);
            }
            o.put("log", log);
        } catch (JSONException ignored) {
        }
        return o.toString();
    }

    private Notification buildNotification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("live", "Live 8D", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1,
                new Intent(this, LiveService.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, "live")
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle("Live 8D is on")
                .setContentText("Music apps you play now get the 8D effect")
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder(null, "Stop", stop).build())
                .setOngoing(true)
                .build();
    }

    @Override
    public void onDestroy() {
        instance = null;
        main.removeCallbacksAndMessages(null);
        unregisterReceiver(receiver);
        for (Attached a : sessions.values()) a.effect.release(); // music sounds normal again
        sessions.clear();
        event("Live 8D stopped");
        super.onDestroy();
    }
}
