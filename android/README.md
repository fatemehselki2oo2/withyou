# WithYou Health Connect bridge

This folder is a small native Android companion for the existing WithYou PWA. It does not replace or wrap the website.

The bridge asks for read-only access to Steps, Sleep, and Heart Rate. When the user taps **Sync recent summaries**, it calculates:

- today's aggregate step count;
- the most recent completed sleep session duration;
- the average, minimum, maximum, and sample count for heart-rate samples from the last 24 hours.

Only one normalized `SensorReading` per available category is sent to `/api/sensors/readings`. Raw records are not written to disk or uploaded. Sync does not run in the background.

## Open and build

1. Install a current stable Android Studio with the Android 36 SDK and JDK 17 support.
2. In Android Studio, choose **Open** and select this `android` folder.
3. Allow Gradle sync to finish.
4. Connect an Android 9+ phone with USB debugging enabled, then run the `app` configuration.

The public Render URL is the default backend. To point a debug build at another HTTPS backend, add this line to your user-level `~/.gradle/gradle.properties` (do not put secrets there):

```properties
WITHYOU_API_BASE_URL=https://your-backend.example.com
```

You can also pass `-PWITHYOU_API_BASE_URL=https://...` to Gradle. This value is bundled into the app, so it must be a public URL only. Never use it for `OPENAI_API_KEY` or another secret.

## Data-source labeling

The normalized source is `watch` because that is the existing WithYou source name, while metadata says `provider: health_connect` and `origin_scope: connected_health_apps`. Health Connect can merge approved records from Samsung Health, the phone, and other apps, so the bridge does not claim that every record came directly from a Galaxy Watch.
