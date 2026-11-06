package com.bilidl.mobile;

import java.io.File;

import com.bilidl.engine.Engine;
import com.bilidl.engine.Server;

/** 桌面测试入口（Android 里由 MainActivity 调用同一套 Engine/Server）。 */
public class MainApp {
    public static void main(String[] args) throws Exception {
        int port = 2196;
        String dataDir = System.getProperty("user.home") + "/.bilidl";
        String webDir = "src/main/assets/web";
        for (int i = 0; i < args.length - 1; i++) {
            if (args[i].equals("--port")) port = Integer.parseInt(args[i + 1]);
            if (args[i].equals("--data")) dataDir = args[i + 1];
            if (args[i].equals("--web")) webDir = args[i + 1];
        }
        File data = new File(dataDir);
        data.mkdirs();
        Engine engine = new Engine(data);
        Server server = new Server(engine, new File(webDir));
        server.start(port, "127.0.0.1");
        System.out.println("READY http://127.0.0.1:" + server.port + " data=" + data.getAbsolutePath());
        Thread.currentThread().join();
    }
}
