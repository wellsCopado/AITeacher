// Signs the tablet app with the family key (APK Signature Scheme v2; minSdk 24 needs no v1) and verifies it.
//   java Sign sign <keystore.p12> <password file> <alias> <unsigned.apk> <signed.apk>
//   java Sign verify <apk>
import com.android.apksig.ApkSigner;
import com.android.apksig.ApkVerifier;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.file.Files;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;
import java.util.Collections;

public class Sign {
    public static void main(String[] a) throws Exception {
        if (a[0].equals("verify")) { verify(new File(a[1])); return; }
        char[] pass = new String(Files.readAllBytes(new File(a[2]).toPath())).trim().toCharArray();
        KeyStore ks = KeyStore.getInstance("PKCS12");
        try (InputStream in = new FileInputStream(a[1])) { ks.load(in, pass); }
        PrivateKey key = (PrivateKey) ks.getKey(a[3], pass);
        X509Certificate cert = (X509Certificate) ks.getCertificate(a[3]);
        ApkSigner.SignerConfig signer = new ApkSigner.SignerConfig.Builder("ADW", key, Collections.singletonList(cert)).build();
        new ApkSigner.Builder(Collections.singletonList(signer))
            .setInputApk(new File(a[4])).setOutputApk(new File(a[5]))
            .setMinSdkVersion(24).setV1SigningEnabled(false).setV2SigningEnabled(true)
            .build().sign();
        verify(new File(a[5]));
    }

    static void verify(File apk) throws Exception {
        ApkVerifier.Result r = new ApkVerifier.Builder(apk).build().verify();
        System.out.println("verified=" + r.isVerified() + " v2=" + r.isVerifiedUsingV2Scheme()
            + (r.getSignerCertificates().isEmpty() ? "" : " signer=" + r.getSignerCertificates().get(0).getSubjectX500Principal()));
        for (ApkVerifier.IssueWithParams e : r.getErrors()) System.out.println("error: " + e);
        if (!r.isVerified()) System.exit(1);
    }
}
