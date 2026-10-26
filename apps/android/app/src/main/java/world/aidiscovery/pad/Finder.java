package world.aidiscovery.pad;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import org.json.JSONObject;

/**
 * Finds the family server on the home Wi-Fi: asks every address in the tablet's own /24 network for
 * GET :8787/v1/hello, and keeps the ones that answer as AI Discovery World.
 */
final class Finder {
    static final int PORT = 8787;

    static final class Server {
        final String url;
        final String name;
        Server(String url, String name) { this.url = url; this.name = name; }
    }

    interface Listener {
        void found(Server s);
        void done(List<Server> all);
    }

    private ExecutorService pool;
    /** Bumped by every scan and stop, so answers from an older scan are dropped. */
    private final AtomicInteger generation = new AtomicInteger();

    /** "192.168.31.218", "192.168.31.218:8787" or "http://…" → "http://192.168.31.218:8787". */
    static String normalize(String typed) {
        String s = typed.trim().replaceAll("/+$", "");
        if (s.isEmpty()) return null;
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://" + s;
        try {
            URL u = new URL(s);
            if (u.getHost().isEmpty()) return null;
            int port = u.getPort() == -1 ? PORT : u.getPort();
            return u.getProtocol() + "://" + u.getHost() + ":" + port;
        } catch (Exception e) {
            return null;
        }
    }

    /** Asks one address; null when it isn't our server. */
    static Server probe(String base, int connectMs, int readMs) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(base + "/v1/hello").openConnection();
            c.setConnectTimeout(connectMs);
            c.setReadTimeout(readMs);
            c.setUseCaches(false);
            if (c.getResponseCode() != 200) return null;
            JSONObject j = new JSONObject(read(c.getInputStream()));
            if (!"ai-discovery-world".equals(j.optString("app"))) return null;
            return new Server(base, j.optString("name", new URL(base).getHost()));
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String read(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        for (int n; (n = in.read(buf)) > 0 && out.size() < 65536; ) out.write(buf, 0, n);
        in.close();
        return out.toString(StandardCharsets.UTF_8.name());
    }

    /** The last server first, then the emulator's host, then every neighbour on the tablet's networks. */
    static List<String> candidates(String last) {
        Set<String> out = new LinkedHashSet<>();
        if (last != null) out.add(last);
        out.add("http://10.0.2.2:" + PORT); // an Android emulator's view of the computer it runs on
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    InetAddress a = ia.getAddress();
                    if (!(a instanceof Inet4Address) || !a.isSiteLocalAddress()) continue;
                    byte[] b = a.getAddress();
                    String prefix = (b[0] & 255) + "." + (b[1] & 255) + "." + (b[2] & 255) + ".";
                    for (int i = 1; i < 255; i++) if (i != (b[3] & 255)) out.add("http://" + prefix + i + ":" + PORT);
                }
            }
        } catch (Exception ignored) {
            // no network interfaces readable: only the saved and typed addresses are tried
        }
        return new ArrayList<>(out);
    }

    /** Scans in the background; the listener is called from worker threads. */
    synchronized void scan(String last, Listener l) {
        stop();
        final int gen = generation.incrementAndGet();
        final ExecutorService p = Executors.newFixedThreadPool(48);
        pool = p;
        final List<Server> all = Collections.synchronizedList(new ArrayList<>());
        for (final String base : candidates(last)) {
            p.execute(() -> {
                if (generation.get() != gen) return;
                Server s = probe(base, 500, 1500);
                if (s != null && generation.get() == gen) { all.add(s); l.found(s); }
            });
        }
        p.shutdown(); // runs what was queued, takes nothing new
        new Thread(() -> {
            try { p.awaitTermination(30, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
            if (generation.get() == gen) l.done(new ArrayList<>(all));
        }).start();
    }

    synchronized void stop() {
        generation.incrementAndGet();
        if (pool != null) pool.shutdownNow();
        pool = null;
    }
}
