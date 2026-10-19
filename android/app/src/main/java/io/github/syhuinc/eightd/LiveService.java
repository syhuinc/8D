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
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.audiofx.AudioEffect;
import android.media.audiofx.DynamicsProcessing;
import android.media.audiofx.Visualizer;
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
import java.util.Arrays;
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
 * "Follow the song" (optional, needs the record-audio permission): a Visualizer
 * on the same session reads the music's spectrum before our effect, finds the
 * kick/bass hits, and moves the sound on each hit, as the converter's "Follow
 * the music" does for files. Without hits for a few seconds it circles on its own.
 *
 * Limits: the effect works per ear, so it can't move sound from one ear to the
 * other (a hard-left instrument fades rather than travels). Apps that never
 * announce their session are not reached.
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
    // Beat moves, in degrees (0 = front, 90 = right), the same as the converter's (auto.js).
    private static final int[] SCATTER = {90, 225, 330, 135, 260, 30, 190, 300, 60, 210, 340, 120};
    private static final int[] BOUNCE = {80, -80};
    private static final long BEAT_TIMEOUT = 3_000_000_000L;   // no hit for this long: circle on its own
    private static final long SILENCE_TIMEOUT = 5_000_000_000L;

    private static volatile LiveService instance;

    private final Map<Integer, Attached> sessions = new LinkedHashMap<>();
    private Handler main;
    private long lastFrameAt;
    private long settingsReadAt;
    private double angle;      // where the sound is now, radians: 0 = front, then right, back, left
    private double period = 8;  // seconds per circle, from the shared settings
    private double depth = 1;   // effect strength 0..1
    private boolean keepVocals = true; // shared "Keep vocals in the center" setting
    private boolean allAudio;          // shared "Process all audio" setting
    private boolean follow;            // "Follow the song" setting
    private String motion = "scatter"; // shared "Movement" setting

    // Following the beat
    private final Beats beats = new Beats();
    private long lastBeatAt;           // 0 = not following
    private int beatCount, moveIndex;
    private double glideFrom, glideTo, glideSeconds;
    private long glideStartedAt, heardAt;
    private boolean silenceReported;
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
        final int session;
        final String packageName;
        final DynamicsProcessing effect;
        Visualizer ears; // "Follow the song": reads this session's sound
        byte[] fft;

        Attached(int session, String packageName, DynamicsProcessing effect) {
            this.session = session;
            this.packageName = packageName;
            this.effect = effect;
        }
    }

    /**
     * Finds kick/bass hits: a sudden rise of the bass level (dB) well above
     * how much it usually rises, judged against the last two seconds.
     */
    static final class Beats {
        private static final long MIN_GAP = 250_000_000L; // at most 240 hits a minute
        private double previous = Double.NaN;
        private final double[] rises = new double[50];   // 2 s at 25 readings a second
        private int readings;
        private long lastAt;
        private final double[] gaps = new double[8];
        private int gapCount;

        boolean push(double level, long now) {
            double rise = Double.isNaN(previous) ? 0 : Math.max(0, level - previous);
            previous = level;
            int n = Math.min(readings, rises.length);
            double mean = 0, spread = 0;
            for (int i = 0; i < n; i++) mean += rises[i];
            mean = n > 0 ? mean / n : 0;
            for (int i = 0; i < n; i++) spread += Math.abs(rises[i] - mean);
            spread = n > 0 ? spread / n : 0;
            rises[readings++ % rises.length] = rise;
            boolean hit = n >= 10 && level > 6 && rise > Math.max(4, mean + 2.5 * spread) && now - lastAt > MIN_GAP;
            if (!hit) return false;
            double gap = (now - lastAt) / 1e9;
            if (lastAt != 0 && gap < 1.5) gaps[gapCount++ % gaps.length] = gap;
            lastAt = now;
            return true;
        }

        /** Typical time between hits (s), the median of the recent ones. */
        double interval() {
            int n = Math.min(gapCount, gaps.length);
            if (n == 0) return 0.5;
            double[] g = Arrays.copyOf(gaps, n);
            Arrays.sort(g);
            return g[n / 2];
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
        goForeground();
        IntentFilter filter = new IntentFilter();
        filter.addAction(AudioEffect.ACTION_OPEN_AUDIO_EFFECT_CONTROL_SESSION);
        filter.addAction(AudioEffect.ACTION_CLOSE_AUDIO_EFFECT_CONTROL_SESSION);
        // Exported: these broadcasts come from other apps. Older Android ignores the flag.
        registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
        lastFrameAt = System.nanoTime();
        readSettings(lastFrameAt);
        event("Live 8D started" + (allAudio ? " (all audio)" : "") + (follow ? ", following the song" : "")
                + ". Now press play in your music app.");
        main.post(this::frame);
    }

    private boolean canListen() {
        return checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * Android 11+ only lets a background app listen while it runs a foreground
     * service of the microphone type, and Android 14+ only grants that type with
     * the permission. Called again when the permission is granted while running.
     */
    private void goForeground() {
        if (Build.VERSION.SDK_INT >= 34) {
            int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                    | (canListen() ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0);
            startForeground(NOTIFICATION_ID, buildNotification(), type);
        } else {
            startForeground(NOTIFICATION_ID, buildNotification());
        }
    }

    /** The page got the record-audio permission: start listening if live mode is on. */
    static void permissionGranted() {
        LiveService s = instance;
        if (s == null) return;
        s.main.post(() -> {
            if (instance != s) return;
            s.goForeground();
            s.settingsReadAt = 0; // re-read settings ("Follow the song" was just switched on)
            if (s.follow) for (Attached a : s.sessions.values()) s.startListening(a);
        });
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
            Attached a = new Attached(session, pkg, effect);
            sessions.put(session, a);
            event("  attached to " + name(pkg) + (effect.hasControl() ? "" : " (another effect app has control!)"));
            if (follow) startListening(a);
        } catch (RuntimeException e) {
            event("  could not attach to " + name(pkg) + ": " + e.getMessage());
        }
    }

    private void detach(int session) {
        Attached a = sessions.remove(session);
        if (a == null) return;
        stopListening(a);
        a.effect.release();
        event("  released " + name(a.packageName));
    }

    /** "Follow the song": a Visualizer on the session (it sits before our effect, so it hears the original). */
    private void startListening(Attached a) {
        if (a.ears != null) return;
        if (!canListen()) {
            event("  can't follow " + name(a.packageName) + ": allow 8D Converter to record audio");
            return;
        }
        try {
            Visualizer v = new Visualizer(a.session);
            // If another app already runs a visualizer on this session (say the music
            // app's own), ours shares it and comes back enabled: keep its settings then.
            if (!v.getEnabled()) {
                v.setCaptureSize(Visualizer.getCaptureSizeRange()[1]);
                v.setScalingMode(Visualizer.SCALING_MODE_AS_PLAYED);
                v.setEnabled(true);
            }
            a.ears = v;
            a.fft = new byte[v.getCaptureSize()];
            heardAt = System.nanoTime();
            silenceReported = false;
            event("  listening to " + name(a.packageName) + " for the beat");
        } catch (RuntimeException e) {
            event("  can't listen to " + name(a.packageName) + ": " + e.getMessage());
        }
    }

    private static void stopListening(Attached a) {
        if (a.ears == null) return;
        a.ears.release();
        a.ears = null;
    }

    /** Reads the bass level from every session we listen to; on a hit, starts a move. */
    private void listen(long now) {
        double bass = 0, all = 0;
        String who = null;
        for (Attached a : sessions.values()) {
            if (a.ears == null) continue;
            try {
                if (a.ears.getFft(a.fft) != Visualizer.SUCCESS) continue;
                double binHz = a.ears.getSamplingRate() / 1000.0 / a.fft.length;
                for (int k = 1; k < a.fft.length / 2; k++) {
                    double re = a.fft[2 * k], im = a.fft[2 * k + 1], power = re * re + im * im;
                    all += power;
                    if (k == 1 || k * binHz <= 160) bass += power; // kick and bass line
                }
                who = a.packageName;
            } catch (RuntimeException e) {
                event("  stopped hearing " + name(a.packageName) + ": " + e.getMessage());
                stopListening(a);
            }
        }
        if (who == null) return;
        if (all > 0) {
            if (silenceReported) event("  hearing " + name(who) + " now");
            heardAt = now;
            silenceReported = false;
        } else if (!silenceReported && now - heardAt > SILENCE_TIMEOUT) {
            event("  hearing only silence from " + name(who) + ": paused, or it doesn't let apps listen. Circling on its own.");
            silenceReported = true;
        }
        if (beats.push(10 * Math.log10(bass + 1), now)) onBeat(now, who);
    }

    /** A hit: glide to the next spot, quickly enough to land before the next hit. */
    private void onBeat(long now, String who) {
        if (lastBeatAt == 0) event("following the beat of " + name(who));
        lastBeatAt = now;
        beatCount++;
        double gap = beats.interval();
        double target;
        switch (motion) {
            case "bounce":
                target = Math.toRadians(BOUNCE[moveIndex++ % BOUNCE.length]);
                break;
            case "circle": // a step per hit, about one circle per orbit time
                int steps = (int) Math.max(4, Math.min(32, Math.round(period / gap)));
                target = angle + 2 * Math.PI / steps;
                break;
            default:
                target = Math.toRadians(SCATTER[moveIndex++ % SCATTER.length]);
        }
        double turn = Math.IEEEremainder(target - angle, 2 * Math.PI); // the short way round
        glideFrom = angle;
        glideTo = angle + turn;
        glideStartedAt = now;
        glideSeconds = Math.min(0.3, 0.35 * gap);
        if (debugLog) Log.d(TAG, String.format(Locale.US, "beat %d gap=%.3f to=%.0f", beatCount, gap, Math.toDegrees(glideTo)));
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
        double dt = Math.min(0.2, (now - lastFrameAt) / 1e9);
        lastFrameAt = now;
        if (follow) listen(now);
        if (lastBeatAt != 0 && now - lastBeatAt > BEAT_TIMEOUT) {
            event("no beat for 3 s: circling on its own");
            lastBeatAt = 0;
        }
        if (lastBeatAt != 0) { // following: ease into the spot picked on the last hit
            double u = Math.min(1, (now - glideStartedAt) / 1e9 / glideSeconds);
            angle = glideFrom + (glideTo - glideFrom) * u * u * (3 - 2 * u);
        } else {
            angle += 2 * Math.PI * dt / period;
        }
        angle = Math.IEEEremainder(angle, 2 * Math.PI);
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
            period = Math.max(2, Math.min(20, s.optDouble("period", 8)));
            depth = Math.max(0, Math.min(1, s.optDouble("strength", 1)));
            keepVocals = s.optBoolean("vocals", true);
            motion = s.optString("motion", "scatter");
            setAllAudio(s.optBoolean("liveAll", false));
            setFollow(s.optBoolean("liveFollow", false));
        } catch (JSONException ignored) {
        }
    }

    private void setFollow(boolean on) {
        if (on == follow) return;
        follow = on;
        event("Follow the song: " + (on ? "on" : "off"));
        for (Attached a : sessions.values()) {
            if (on) startListening(a);
            else stopListening(a);
        }
        if (!on) lastBeatAt = 0;
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
            if (s != null && s.follow) {
                JSONObject f = new JSONObject();
                f.put("beats", s.beatCount);
                f.put("onBeat", s.lastBeatAt != 0);
                f.put("bpm", s.lastBeatAt != 0 ? Math.round(60 / s.beats.interval()) : 0);
                o.put("follow", f);
            }
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
        for (Attached a : sessions.values()) { // music sounds normal again
            stopListening(a);
            a.effect.release();
        }
        sessions.clear();
        event("Live 8D stopped");
        super.onDestroy();
    }
}
