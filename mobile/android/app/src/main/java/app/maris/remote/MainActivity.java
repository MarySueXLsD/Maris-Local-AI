package app.maris.remote;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugins that live in this app (not in node_modules) are registered by hand.
        registerPlugin(ScannerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
