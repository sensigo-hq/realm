// Java capture (printer captures, FAKE values only). Reads {c, v} JSON lines on stdin (parsed with Gson);
// writes {p, c, hex (UTF-8), u16 (UTF-16 code units), err}.
// Libraries on the classpath: Gson, Jackson 2 (com.fasterxml), Jackson 3 (tools.jackson), and the Jenkins
// credentials-binding plugin's RELEASED jar (its factories called by reflection; Jenkins core stubbed: hudson.ExtensionPoint,
// hudson.ExtensionList).
import java.io.*;
import java.lang.reflect.Method;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.*;

public class Cap {
    static String hex(String s) {
        StringBuilder sb = new StringBuilder();
        for (byte b : s.getBytes(StandardCharsets.UTF_8)) sb.append(String.format("%02x", b & 0xff));
        return sb.toString();
    }
    static String u16(String s) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < s.length(); i++) sb.append(String.format("%04x", (int) s.charAt(i)));
        return sb.toString();
    }
    static String js(String s) { // ASCII-only names and messages
        StringBuilder sb = new StringBuilder("\"");
        for (char ch : s.toCharArray()) {
            if (ch == '"' || ch == '\\') sb.append('\\').append(ch);
            else if (ch < 0x20 || ch > 0x7e) sb.append(String.format("\\u%04x", (int) ch));
            else sb.append(ch);
        }
        return sb.append('"').toString();
    }
    interface F { String apply(String v) throws Exception; }
    static PrintStream out;
    static void emit(String p, String c, String v, F f) {
        String o = ""; String err = null;
        try { o = f.apply(v); if (o == null) { o = ""; err = "null"; } } catch (Throwable t) {
            Throwable x = (t instanceof java.lang.reflect.InvocationTargetException && t.getCause() != null) ? t.getCause() : t;
            err = x.getClass().getName() + ": " + x.getMessage();
        }
        out.println("{\"p\":" + js(p) + ",\"c\":" + js(c) + ",\"hex\":\"" + hex(o) + "\",\"u16\":\"" + u16(o) + "\",\"err\":" + (err == null ? "null" : js(err)) + "}");
    }
    public static void main(String[] args) throws Exception {
        out = new PrintStream(new FileOutputStream(FileDescriptor.out), false, "UTF-8");
        BufferedReader r = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        com.google.gson.Gson gson = new com.google.gson.Gson();
        com.google.gson.Gson gsonNoHtml = new com.google.gson.GsonBuilder().disableHtmlEscaping().create();
        com.fasterxml.jackson.databind.ObjectMapper j2 = new com.fasterxml.jackson.databind.ObjectMapper();
        tools.jackson.databind.json.JsonMapper j3 = tools.jackson.databind.json.JsonMapper.builder().build();
        String pk = "org.jenkinsci.plugins.credentialsbinding.masking.";
        Object bash = Class.forName(pk + "BashSecretPatternFactory").getDeclaredConstructor().newInstance();
        Object batch = Class.forName(pk + "BatchSecretPatternFactory").getDeclaredConstructor().newInstance();
        Object dollar = Class.forName(pk + "DollarSecretPatternFactory").getDeclaredConstructor().newInstance();
        Object base64 = Class.forName(pk + "Base64SecretPatternFactory").getDeclaredConstructor().newInstance();
        Method enc = Class.forName(pk + "SecretPatternFactory").getMethod("getEncodedForms", String.class);
        Method bashUnq = bash.getClass().getDeclaredMethod("getUnquotedForm", String.class); bashUnq.setAccessible(true);
        Method bashQ = bash.getClass().getDeclaredMethod("getQuotedForm", String.class); bashQ.setAccessible(true);
        String meta = "{\"p\":\"meta\",\"c\":\"-\",\"java\":" + js(System.getProperty("java.version"))
            + ",\"gson\":" + js(String.valueOf(com.google.gson.Gson.class.getPackage().getImplementationVersion()))
            + ",\"jackson2\":" + js(com.fasterxml.jackson.databind.cfg.PackageVersion.VERSION.toString())
            + ",\"jackson3\":" + js(tools.jackson.databind.cfg.PackageVersion.VERSION.toString())
            + ",\"jenkinsPluginJar\":" + js(String.valueOf(bash.getClass().getProtectionDomain().getCodeSource().getLocation())) + "}";
        out.println(meta);
        String line;
        while ((line = r.readLine()) != null) {
            if (line.isEmpty()) continue;
            com.google.gson.JsonObject in = com.google.gson.JsonParser.parseString(line).getAsJsonObject();
            String c = in.get("c").getAsString(); String v = in.get("v").getAsString();
            emit("gson.toJson", c, v, x -> gson.toJson(x));
            emit("gson.toJson_obj", c, v, x -> gson.toJson(Collections.singletonMap("k", x)));
            emit("gson.toJson_noHtml", c, v, x -> gsonNoHtml.toJson(x));
            emit("jackson2.writeValueAsString", c, v, x -> j2.writeValueAsString(x));
            emit("jackson2.writeValueAsString_obj", c, v, x -> j2.writeValueAsString(Collections.singletonMap("k", x)));
            emit("jackson3.writeValueAsString", c, v, x -> j3.writeValueAsString(x));
            emit("jackson3.writeValueAsString_obj", c, v, x -> j3.writeValueAsString(Collections.singletonMap("k", x)));
            emit("java.URLEncoder", c, v, x -> URLEncoder.encode(x, StandardCharsets.UTF_8));
            emit("jenkins.Dollar", c, v, x -> String.join("\u0000", new TreeSet<>((Collection<String>) enc.invoke(dollar, x))));
            emit("jenkins.Batch", c, v, x -> String.join("\u0000", new TreeSet<>((Collection<String>) enc.invoke(batch, x))));
            emit("jenkins.Bash.unquoted", c, v, x -> (String) bashUnq.invoke(bash, x));
            emit("jenkins.Bash.quoted", c, v, x -> (String) bashQ.invoke(bash, x));
            emit("jenkins.Bash.all", c, v, x -> String.join("\u0000", new TreeSet<>((Collection<String>) enc.invoke(bash, x))));
            emit("jenkins.Base64", c, v, x -> String.join("\u0000", new TreeSet<>((Collection<String>) enc.invoke(base64, x))));
        }
        out.flush();
    }
}
