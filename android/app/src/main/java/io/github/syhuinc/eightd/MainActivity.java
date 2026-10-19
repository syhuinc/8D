package io.github.syhuinc.eightd;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;

/**
 * Hosts the web app (bundled under assets/www) in a WebView and fills the two
 * gaps a bare WebView has: picking a file for {@code <input type=file>} and
 * saving the exported audio, which arrives from app.js through {@link SaveBridge}.
 */
public class MainActivity extends Activity {

    private static final String START_URL = "file:///android_asset/www/index.html";
    private static final int REQUEST_PICK = 1;
    private static final int REQUEST_SAVE = 2;
    private static final int REQUEST_LISTEN = 5;

    private WebView web;
    private ValueCallback<Uri[]> pickCallback;

    // Export in progress: app.js streams it into this temp file, then the user picks where to save it.
    private File pendingFile;
    private OutputStream pendingOut;
    private String pendingName;
    private String pendingMime;

    // A song shared or opened from another app: copied here, then read by the page (see receiveShared in app.js).
    private volatile File sharedFile;
    private volatile String sharedName;
    private volatile String sharedMime;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true); // debug builds only: lets tests/android drive the page
        }
        FrameLayout root = new FrameLayout(this);
        web = new WebView(this);
        web.setBackgroundColor(Color.TRANSPARENT); // show the themed window background while loading
        root.addView(web);
        setContentView(root);
        drawEdgeToEdge(root);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);

        web.addJavascriptInterface(new SaveBridge(), "Android8D");
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pickCallback != null) pickCallback.onReceiveValue(null);
                pickCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQUEST_PICK);
                    return true;
                } catch (ActivityNotFoundException e) {
                    pickCallback = null;
                    return false;
                }
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Links on the page (credits in the footer) open in the browser.
                Uri uri = request.getUrl();
                String scheme = uri.getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (ActivityNotFoundException ignored) {
                    }
                    return true;
                }
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (sharedFile != null) offerShared(); // shared before the page was ready
            }
        });

        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) {
            web.loadUrl(START_URL);
        }
        if (savedInstanceState == null) receive(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent); // singleTask: a song shared while the app is open arrives here
        receive(intent);
    }

    /** A song shared to the app (ACTION_SEND) or opened with it (ACTION_VIEW): copy it, then hand it to the page. */
    @SuppressWarnings("deprecation") // getParcelableExtra(String) before Android 13
    private void receive(Intent intent) {
        if (intent == null) return;
        Uri uri = null;
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            uri = Build.VERSION.SDK_INT >= 33
                    ? intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class)
                    : intent.getParcelableExtra(Intent.EXTRA_STREAM);
        } else if (Intent.ACTION_VIEW.equals(intent.getAction())) {
            uri = intent.getData();
        }
        if (uri == null) return;
        String name = displayName(uri);
        String type = getContentResolver().getType(uri);
        String mime = type != null ? type : intent.getType() != null ? intent.getType() : "audio/*";
        Uri source = uri;
        // The read grant lasts while this activity runs; copying keeps the song if the page reloads.
        new Thread(() -> {
            File copy = new File(getCacheDir(), "shared-" + System.nanoTime()); // never overwrites one being read
            boolean ok;
            try (InputStream in = getContentResolver().openInputStream(source);
                 OutputStream out = new FileOutputStream(copy)) {
                if (in == null) throw new IOException("no data");
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                ok = true;
            } catch (IOException | SecurityException e) {
                ok = false;
            }
            boolean copied = ok;
            runOnUiThread(() -> {
                if (!copied) {
                    web.evaluateJavascript("window.__android8dSharedFailed && window.__android8dSharedFailed()", null);
                    return;
                }
                deleteQuietly(sharedFile); // an earlier share the page never took
                sharedName = name;
                sharedMime = mime;
                sharedFile = copy;
                offerShared();
            });
        }, "receive-shared").start();
    }

    private void offerShared() {
        web.evaluateJavascript("window.__android8dShared && window.__android8dShared()", null);
    }

    private String displayName(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
        } catch (RuntimeException ignored) {
        }
        String last = uri.getLastPathSegment();
        return last != null && last.contains(".") ? last : "Shared song";
    }

    /** Draw under the system bars and pad the content so nothing sits beneath them. */
    private void drawEdgeToEdge(View root) {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
        } else {
            root.setSystemUiVisibility(root.getSystemUiVisibility()
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return WindowInsets.CONSUMED;
            }
            v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
    }

    private boolean isDarkTheme() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
    }

    /**
     * Dark mode was switched while the app is open. uiMode is in the manifest's
     * configChanges so the page (and any loaded song) survives; restyle in place.
     */
    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        boolean dark = isDarkTheme();
        getWindow().setBackgroundDrawable(new ColorDrawable(getResources().getColor(R.color.page_bg, getTheme())));
        if (Build.VERSION.SDK_INT >= 30) {
            int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            getWindow().getInsetsController().setSystemBarsAppearance(dark ? 0 : light, light);
        } else {
            View decor = getWindow().getDecorView();
            // Before 27 the light theme keeps an opaque black navigation bar, so only its icons stay light.
            int light = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                    | (Build.VERSION.SDK_INT >= 27 ? View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR : 0);
            int flags = decor.getSystemUiVisibility() & ~light;
            decor.setSystemUiVisibility(dark ? flags : flags | light);
        }
        web.evaluateJavascript("document.documentElement.dataset.theme = '" + (dark ? "dark" : "light") + "'", null);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_PICK) {
            if (pickCallback != null) {
                pickCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                pickCallback = null;
            }
        } else if (requestCode == REQUEST_SAVE) {
            Uri target = resultCode == RESULT_OK && data != null ? data.getData() : null;
            File source = pendingFile;
            if (target == null) {
                deleteQuietly(source);
                notifySaved(false);
                return;
            }
            // Copying a large WAV can take a moment; keep it off the UI thread.
            new Thread(() -> {
                boolean ok = copy(source, target);
                deleteQuietly(source);
                runOnUiThread(() -> notifySaved(ok));
            }).start();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_LISTEN) return;
        boolean granted = grantResults.length > 0 && grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED;
        if (granted && Build.VERSION.SDK_INT >= 28) LiveService.permissionGranted();
        // Asked once and refused for good: Android no longer shows the question, only Settings can allow it.
        boolean askable = shouldShowRequestPermissionRationale(android.Manifest.permission.RECORD_AUDIO);
        web.evaluateJavascript("window.__android8dListen && window.__android8dListen(" + granted + ", " + askable + ")", null);
    }

    private boolean copy(File source, Uri target) {
        try (InputStream in = new FileInputStream(source);
             OutputStream out = getContentResolver().openOutputStream(target)) {
            if (out == null) return false;
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return true;
        } catch (IOException | SecurityException e) {
            return false;
        }
    }

    private void notifySaved(boolean ok) {
        web.evaluateJavascript("window.__android8dSaved && window.__android8dSaved(" + ok + ")", null);
    }

    private static void deleteQuietly(File f) {
        if (f != null && !f.delete()) f.deleteOnExit();
    }

    /** Called from the page (on the WebView's JavaBridge thread): theme, and handing over exported files. */
    private class SaveBridge {
        @JavascriptInterface
        public boolean isDarkTheme() {
            return MainActivity.this.isDarkTheme();
        }

        // Live 8D for other apps (see LiveService). Android 9+ (DynamicsProcessing).
        @JavascriptInterface
        public boolean liveSupported() {
            return Build.VERSION.SDK_INT >= 28;
        }

        @JavascriptInterface
        public void liveStart() {
            if (Build.VERSION.SDK_INT < 28) return;
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 33
                        && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 4); // for the Stop notification
                }
                startForegroundService(new Intent(MainActivity.this, LiveService.class));
            });
        }

        @JavascriptInterface
        public void liveStop() {
            stopService(new Intent(MainActivity.this, LiveService.class));
        }

        // "Follow the song": Live 8D listens to the music app's sound to find the beat.
        @JavascriptInterface
        public boolean canListen() {
            return checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED;
        }

        @JavascriptInterface
        public void requestListen() {
            runOnUiThread(() -> requestPermissions(new String[]{android.Manifest.permission.RECORD_AUDIO}, REQUEST_LISTEN));
        }

        @JavascriptInterface
        public void openAppSettings() {
            runOnUiThread(() -> startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.fromParts("package", getPackageName(), null))));
        }

        @JavascriptInterface
        public String liveStatus() {
            return Build.VERSION.SDK_INT >= 28 ? LiveService.statusJson() : "{\"running\":false,\"apps\":[]}";
        }

        // A song shared from another app (see receive): its name and size, then its bytes in base64 pieces.
        @JavascriptInterface
        public String sharedInfo() {
            File f = sharedFile;
            if (f == null) return "";
            try {
                return new org.json.JSONObject().put("name", sharedName).put("type", sharedMime).put("size", f.length()).toString();
            } catch (org.json.JSONException e) {
                return "";
            }
        }

        @JavascriptInterface
        public String readShared(long offset, int length) {
            File f = sharedFile;
            if (f == null) return "";
            try (RandomAccessFile in = new RandomAccessFile(f, "r")) {
                in.seek(offset);
                byte[] buf = new byte[(int) Math.max(0, Math.min(length, in.length() - offset))];
                in.readFully(buf);
                return Base64.encodeToString(buf, Base64.NO_WRAP);
            } catch (IOException e) {
                return "";
            }
        }

        @JavascriptInterface
        public void sharedDone() {
            File f = sharedFile;
            sharedFile = null;
            deleteQuietly(f);
        }

        // Remembered settings. SharedPreferences + commit() reach disk right away;
        // WebView localStorage is flushed lazily and lost if the app is killed soon after.
        @JavascriptInterface
        public String loadSettings() {
            return getSharedPreferences("settings", MODE_PRIVATE).getString("json", "");
        }

        @JavascriptInterface
        public void saveSettings(String json) {
            getSharedPreferences("settings", MODE_PRIVATE).edit().putString("json", json).commit();
        }

        @JavascriptInterface
        public boolean begin(String name, String mime) {
            closePending();
            try {
                pendingFile = new File(getCacheDir(), "export.tmp");
                pendingOut = new BufferedOutputStream(new FileOutputStream(pendingFile));
                pendingName = name;
                pendingMime = mime == null || mime.isEmpty() ? "application/octet-stream" : mime;
                return true;
            } catch (IOException e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean append(String base64) {
            try {
                pendingOut.write(Base64.decode(base64, Base64.DEFAULT));
                return true;
            } catch (IOException | IllegalArgumentException | NullPointerException e) {
                return false;
            }
        }

        @JavascriptInterface
        public void finish() {
            if (!closePending()) {
                runOnUiThread(() -> notifySaved(false));
                return;
            }
            Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(pendingMime)
                    .putExtra(Intent.EXTRA_TITLE, pendingName);
            runOnUiThread(() -> {
                try {
                    startActivityForResult(save, REQUEST_SAVE);
                } catch (ActivityNotFoundException e) {
                    deleteQuietly(pendingFile);
                    notifySaved(false);
                }
            });
        }

        private boolean closePending() {
            if (pendingOut == null) return pendingFile != null;
            try {
                pendingOut.close();
                return true;
            } catch (IOException e) {
                return false;
            } finally {
                pendingOut = null;
            }
        }
    }
}
