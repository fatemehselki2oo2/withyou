# WithYou Health Connect bridge

This folder is a small native Android companion for the existing WithYou PWA. It does not replace or wrap the website.

The bridge asks for read-only access to Steps, Sleep, and Heart Rate. When the user taps **Sync recent summaries**, it calculates everything locally on the phone:

- today's aggregate step count;
- the most recent completed full sleep duration (parent sessions that overlap or are no more than one hour apart are merged so a final fragment is not selected by itself);
- the average, minimum, maximum, and sample count for heart-rate samples from the last 24 hours.
- a 30-day average of daily steps, using completed local calendar days that contain data;
- a 30-day average of completed sleep episodes;
- a 30-day heart-rate average.

Up to six normalized `SensorReading` summaries are sent to `/api/sensors/readings`: one current and one baseline summary per available category. The backend keeps only the latest six compact summaries in memory so the WithYou frontend can compare current values with personal baselines. Baseline metadata may include a count, minimum, maximum, and standard deviation, but never the underlying daily values, sleep sessions/stages, or heart-rate samples. Raw records are kept in memory only while calculating and are not written to disk or uploaded. Sync does not run in the background.

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

The normalized source is `watch` because that is the existing WithYou source name. Every upload includes `provider: health_connect`, `summary_kind: current` or `baseline`, and `raw_history_uploaded: false`. Metadata also says `origin_scope: connected_health_apps`, because Health Connect can merge approved records from Samsung Health, the phone, and other apps; the bridge does not claim that every record came directly from a Galaxy Watch.
