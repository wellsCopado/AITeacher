package world.aidiscovery.pad;

import android.content.Context;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.webkit.WebView;

import java.util.Locale;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The tablet's own voice, for when the family Mac's voice can't be used. Android's WebView has no
 * speechSynthesis, so the Pad page calls this through window.AdwNative and hears back through
 * window.__adwSpeech(id, 'end' | 'error').
 */
final class Speech implements TextToSpeech.OnInitListener {
    private final TextToSpeech tts;
    private final WebView web;
    private volatile boolean ready;

    Speech(Context c, WebView web) {
        this.web = web;
        this.tts = new TextToSpeech(c.getApplicationContext(), this);
    }

    @Override
    public void onInit(int status) {
        ready = status == TextToSpeech.SUCCESS;
        if (!ready) return;
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) { }
            @Override public void onDone(String id) { fire(id, "end"); }
            @Override public void onError(String id) { fire(id, "error"); }
            @Override public void onStop(String id, boolean interrupted) { fire(id, "end"); }
        });
    }

    private static Locale locale(String lang) {
        return lang != null && lang.startsWith("zh") ? Locale.SIMPLIFIED_CHINESE : Locale.US;
    }

    private boolean has(Locale l) {
        return ready && tts.isLanguageAvailable(l) >= TextToSpeech.LANG_AVAILABLE;
    }

    void speak(String id, String text, String lang, float rate) {
        Locale l = locale(lang);
        if (!has(l)) { fire(id, "error"); return; }
        synchronized (tts) {
            tts.setLanguage(l);
            tts.setSpeechRate(rate > 0 ? rate : 1f);
            if (tts.speak(text, TextToSpeech.QUEUE_ADD, new Bundle(), id) != TextToSpeech.SUCCESS) fire(id, "error");
        }
    }

    /** The languages this tablet can speak, shaped like speechSynthesis.getVoices(). */
    String voices() {
        JSONArray out = new JSONArray();
        try {
            if (has(Locale.SIMPLIFIED_CHINESE)) out.put(new JSONObject().put("name", "平板中文").put("lang", "zh-CN").put("localService", true).put("default", true));
            if (has(Locale.US)) out.put(new JSONObject().put("name", "平板英文").put("lang", "en-US").put("localService", true).put("default", false));
        } catch (Exception ignored) { }
        return out.toString();
    }

    void stop() {
        if (ready) tts.stop();
    }

    void shutdown() {
        tts.shutdown();
    }

    private void fire(String id, String type) {
        web.post(() -> web.evaluateJavascript("window.__adwSpeech && window.__adwSpeech(" + JSONObject.quote(id) + "," + JSONObject.quote(type) + ")", null));
    }
}
