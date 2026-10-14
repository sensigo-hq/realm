// STUB of Jenkins core's ExtensionList: only lookup()'s signature, never called (the capture calls the factories directly).
package hudson;
public class ExtensionList<T> extends java.util.ArrayList<T> {
    public static <T> ExtensionList<T> lookup(Class<T> type) { throw new UnsupportedOperationException("stub"); }
}
