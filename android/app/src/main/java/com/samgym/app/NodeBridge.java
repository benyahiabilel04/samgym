package com.samgym.app;

public class NodeBridge {
    static { System.loadLibrary("node"); System.loadLibrary("native-lib"); }
    public static native int startNode(String[] args);
}
