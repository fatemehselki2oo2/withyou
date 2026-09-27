# WithYou Health Helper

This folder is a small native Android helper for the existing WithYou PWA. It does not replace or wrap the website.

The helper asks for read-only access to Steps, Sleep, and Heart Rate. The WithYou website can open the installed helper through the package-scoped `withyou://health/connect` link. That flow requests any missing permissions, performs one foreground sync, and returns to the website. The same sync can still be started manually from the helper.

During a sync, the helper calculates everything locally on the phone:

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

The helper returns to `https://withyou-nine.vercel.app` after a web-started sync. For a different public frontend, set another non-secret Gradle property:

```properties
WITHYOU_WEB_URL=https://your-frontend.example.com
```

This hackathon helper is not published in an app store. Install it by running the `app` configuration from Android Studio on the phone, or build `assembleDebug` and install the generated debug APK on a test device. After it is installed, **Connect Health** on the website opens it directly.

The website expects the public APK at this stable GitHub Release asset URL:

```text
https://github.com/fatemehselki2oo2/withyou/releases/latest/download/withyou-health-helper.apk
```

That URL works only after a release containing an asset named exactly `withyou-health-helper.apk` is published. No release is created by the source build. For the hackathon, the verified debug APK is suitable for deliberate sideloading on test phones, but Android still shows its own install confirmation. It is signed with the local Android debug key and should not be represented as a production/store-signed artifact. A longer-lived public release should use a private release keystore stored outside this repository; no signing secrets belong in source control.

## Connect from the WithYou website

1. Open `https://withyou-nine.vercel.app` in Chrome on the Android phone.
2. Tap **Connect Health**.
3. Android opens **WithYou Health Helper** and, when needed, shows the existing Health Connect read-permission screen.
4. Allow Steps, Sleep, and Heart Rate. The helper performs one foreground sync using the existing compact-summary flow.
5. After a successful upload, the helper reopens WithYou. The website checks immediately and continues polling, so Health changes to **Connected / Synced** without a page refresh.

If Health Connect needs to be installed or updated, the helper exposes an install/update action. **Review health permissions** first opens this helper’s Android health-permission screen, then falls back to general Health Connect settings and finally to short manual directions when Android offers neither route. Health Connect is integrated into Android 14 and newer; supported older Android versions use the Health Connect provider app. No background sync is added by this flow.

## Data-source labeling

The normalized source is `watch` because that is the existing WithYou source name. Every upload includes `provider: health_connect`, `summary_kind: current` or `baseline`, and `raw_history_uploaded: false`. Metadata also says `origin_scope: connected_health_apps`, because Health Connect can merge approved records from Samsung Health, the phone, and other apps; the helper does not claim that every record came directly from a Galaxy Watch.
