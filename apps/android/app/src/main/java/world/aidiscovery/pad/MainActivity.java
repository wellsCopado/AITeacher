package world.aidiscovery.pad;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.List;

/**
 * The tablet app: the Pad pages from the family Mac, full screen, with sound that starts without a tap.
 * First run (or when the Mac's address changed) it looks for the Mac on the home Wi-Fi by itself.
 */
public class MainActivity extends Activity {
    static final String TAG = "ADW";
    private static final int BG = Color.rgb(14, 26, 32);
    private static final int ACCENT = Color.rgb(79, 179, 169);

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Finder finder = new Finder();
    private SharedPreferences prefs;
    private WebView web;
    private Speech speech;
    private String server;

    private View setup;
    private TextView status;
    private LinearLayout foundList;
    private EditText address;
    private boolean connecting;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }
        prefs = getSharedPreferences("adw", MODE_PRIVATE);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        web = newWebView();
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setup = buildSetup();
        root.addView(setup, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        immersive();

        speech = new Speech(this, web);
        String last = prefs.getString("server", null);
        if (last != null) connect(last, false);
        else showSetup("正在家里的 Wi-Fi 里找装了「AI 探索世界」的 Mac…", true);
    }

    // ---- the Pad pages ----

    private WebView newWebView() {
        WebView w = new WebView(this);
        w.setBackgroundColor(BG);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // narration plays without a tap first
        s.setTextZoom(100); // the lesson layout is measured; a large system font would break it
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setUserAgentString(s.getUserAgentString() + " ADWPad/" + BuildConfig.VERSION_NAME);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        w.addJavascriptInterface(new Bridge(), "AdwNative");
        w.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl(), base = Uri.parse(server == null ? "" : server);
                if (u.getHost() != null && u.getHost().equals(base.getHost()) && u.getPort() == base.getPort()) return false;
                // anything outside the family server (a source link) opens in the tablet's browser
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (!r.isForMainFrame()) return;
                Log.w(TAG, "load failed: " + e.getDescription());
                showSetup("连不上家里的 Mac（" + e.getDescription() + "）。请确认 Mac 开着、平板和 Mac 连的是同一个 Wi-Fi。正在重新找…", true);
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                Log.i(TAG, "loaded " + url);
                // lets the automated test read what the child sees
                if (BuildConfig.DEBUG) ui.postDelayed(() -> v.evaluateJavascript("(document.body && document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300)", t -> Log.i(TAG, "page: " + t)), 6000);
            }

            @Override
            public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail d) {
                Log.w(TAG, "web page process gone; reloading");
                recreate();
                return true;
            }
        });
        w.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.i(TAG, "console " + m.messageLevel() + ": " + m.message());
                return true;
            }
        });
        return w;
    }

    /** What the Pad page can ask of the app (window.AdwNative). Called on a background thread. */
    final class Bridge {
        @JavascriptInterface public String version() { return BuildConfig.VERSION_NAME; }
        @JavascriptInterface public void speak(String id, String text, String lang, float rate) { speech.speak(id, text, lang, rate); }
        @JavascriptInterface public void cancelSpeech() { speech.stop(); }
        @JavascriptInterface public String voices() { return speech.voices(); }
        @JavascriptInterface public void changeServer() { ui.post(() -> showSetup("选一台 Mac，或输入地址。", true)); }
    }

    /** Checks the address first, so a Mac that moved to a new address sends us looking for it instead of to an error page. */
    private void connect(String base, boolean typed) {
        if (connecting) return;
        connecting = true;
        if (typed) status.setText("正在连接 " + base + " …");
        new Thread(() -> {
            Finder.Server s = Finder.probe(base, 1500, 3000);
            ui.post(() -> {
                connecting = false;
                if (s != null) open(s);
                else if (typed) status.setText(base + " 没有回应。请看 Mac 上「AI 探索世界」是不是开着，地址有没有输错。");
                else showSetup("上次连的 Mac（" + base + "）没有回应，正在重新找…", true);
            });
        }).start();
    }

    private void open(Finder.Server s) {
        finder.stop();
        server = s.url;
        prefs.edit().putString("server", s.url).putString("serverName", s.name).apply();
        setup.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        Log.i(TAG, "server " + s.url + " (" + s.name + ")");
        web.loadUrl(s.url + "/pad/");
    }

    // ---- first run: find the Mac ----

    private View buildSetup() {
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER_HORIZONTAL);
        int pad = dp(32);
        col.setPadding(pad, dp(48), pad, pad);

        TextView title = text("AI 探索世界", 30, Color.WHITE);
        col.addView(title);
        status = text("", 18, Color.rgb(200, 215, 220));
        status.setGravity(Gravity.CENTER);
        status.setPadding(0, dp(16), 0, dp(16));
        col.addView(status, new LinearLayout.LayoutParams(dp(640), ViewGroup.LayoutParams.WRAP_CONTENT));
        foundList = new LinearLayout(this);
        foundList.setOrientation(LinearLayout.VERTICAL);
        col.addView(foundList);

        TextView hint = text("也可以输入家里 Mac 的地址（Mac 上「AI 探索世界」→ 设备与数据 里能看到）", 15, Color.rgb(150, 170, 175));
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(0, dp(28), 0, dp(8));
        col.addView(hint, new LinearLayout.LayoutParams(dp(640), ViewGroup.LayoutParams.WRAP_CONTENT));
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        address = new EditText(this);
        address.setHint("例如 192.168.31.218");
        address.setTextColor(Color.WHITE);
        address.setHintTextColor(Color.rgb(110, 130, 135));
        address.setSingleLine(true);
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setImeOptions(EditorInfo.IME_ACTION_GO);
        address.setOnEditorActionListener((v, id, ev) -> { typed(); return true; });
        String last = prefs.getString("server", null);
        if (last != null) address.setText(Uri.parse(last).getHost());
        row.addView(address, new LinearLayout.LayoutParams(dp(360), ViewGroup.LayoutParams.WRAP_CONTENT));
        Button go = button("连接", true);
        go.setOnClickListener(v -> typed());
        row.addView(go);
        col.addView(row);
        Button again = button("重新找", false);
        again.setOnClickListener(v -> showSetup("正在家里的 Wi-Fi 里找装了「AI 探索世界」的 Mac…", true));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(20);
        col.addView(again, lp);

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(BG);
        scroll.setFillViewport(true);
        scroll.addView(col);
        scroll.setVisibility(View.GONE);
        return scroll;
    }

    private void typed() {
        String base = Finder.normalize(address.getText().toString());
        if (base == null) { status.setText("请输入 Mac 的地址，例如 192.168.31.218"); return; }
        connect(base, true);
    }

    private void showSetup(String message, boolean scan) {
        web.stopLoading();
        web.setVisibility(View.INVISIBLE);
        setup.setVisibility(View.VISIBLE);
        status.setText(message);
        foundList.removeAllViews();
        if (!scan) return;
        finder.scan(prefs.getString("server", null), new Finder.Listener() {
            @Override public void found(Finder.Server s) {
                ui.post(() -> {
                    Button b = button("连接「" + s.name + "」  " + Uri.parse(s.url).getHost(), true);
                    b.setOnClickListener(v -> open(s));
                    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                    lp.topMargin = dp(8);
                    foundList.addView(b, lp);
                });
            }

            @Override public void done(List<Finder.Server> all) {
                ui.post(() -> {
                    if (setup.getVisibility() != View.VISIBLE) return;
                    if (all.size() == 1) open(all.get(0));
                    else if (all.isEmpty()) status.setText("没找到。请确认：家里的 Mac 开着并打开了「AI 探索世界」，平板和 Mac 连的是同一个 Wi-Fi。也可以在下面直接输入地址。");
                    else status.setText("找到 " + all.size() + " 台，选一台：");
                });
            }
        });
    }

    // ---- full screen, lifecycle ----

    private void immersive() {
        View d = getWindow().getDecorView();
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController c = d.getWindowInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            d.setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) immersive();
    }

    @Override
    public boolean onKeyDown(int code, KeyEvent e) {
        if (code == KeyEvent.KEYCODE_BACK) {
            if (web.getVisibility() == View.VISIBLE && web.canGoBack()) web.goBack();
            else moveTaskToBack(true);
            return true;
        }
        return super.onKeyDown(code, e);
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
        speech.stop();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        immersive();
    }

    @Override
    protected void onDestroy() {
        finder.stop();
        speech.shutdown();
        web.destroy();
        super.onDestroy();
    }

    // ---- small view helpers ----

    private int dp(int v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    private TextView text(String s, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        return t;
    }

    private Button button(String label, boolean primary) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        b.setTextColor(primary ? Color.rgb(8, 24, 26) : Color.WHITE);
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(10));
        if (primary) bg.setColor(ACCENT);
        else { bg.setColor(Color.TRANSPARENT); bg.setStroke(dp(1), Color.rgb(110, 140, 145)); }
        b.setBackground(bg);
        b.setPadding(dp(22), dp(10), dp(22), dp(10));
        return b;
    }
}
