package com.bilidl.engine;

/** 引擎异常族。 */
public class Errors {
    public static class BiliError extends RuntimeException {
        public final int code;
        public BiliError(String msg) { this(msg, 0); }
        public BiliError(String msg, int code) { super(msg); this.code = code; }
    }
    public static class AuthRequired extends BiliError {
        public AuthRequired(String m) { super(m); }
    }
    public static class NotFound extends BiliError {
        public NotFound(String m) { super(m); }
    }
    public static class RiskControl extends BiliError {
        public RiskControl(String m) { super(m); }
    }
    public static class ParseError extends BiliError {
        public ParseError(String m) { super(m); }
    }
    public static class DownloadError extends BiliError {
        public DownloadError(String m) { super(m); }
    }
}
