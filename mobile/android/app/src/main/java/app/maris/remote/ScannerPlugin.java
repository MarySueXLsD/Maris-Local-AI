package app.maris.remote;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

/**
 * Scans the pairing QR code shown on the computer with Google's code scanner. The scanner runs in
 * Google Play services, so Maris itself needs no camera permission and never sees the camera image.
 */
@CapacitorPlugin(name = "MarisScanner")
public class ScannerPlugin extends Plugin {

    @PluginMethod
    public void available(PluginCall call) {
        int status = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(getContext());
        JSObject ret = new JSObject();
        ret.put("available", status == ConnectionResult.SUCCESS);
        call.resolve(ret);
    }

    @PluginMethod
    public void scan(PluginCall call) {
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .build();
        GmsBarcodeScanner scanner = GmsBarcodeScanning.getClient(getActivity(), options);
        scanner
            .startScan()
            .addOnSuccessListener(barcode -> {
                JSObject ret = new JSObject();
                ret.put("text", barcode.getRawValue());
                call.resolve(ret);
            })
            .addOnCanceledListener(() -> {
                JSObject ret = new JSObject();
                ret.put("cancelled", true);
                call.resolve(ret);
            })
            .addOnFailureListener(e -> call.reject("The code scanner is not available: " + e.getMessage()));
    }
}
