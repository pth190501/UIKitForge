plugins {
    id("com.android.library") version "9.1.1"
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.10"
}

android {
    namespace = "com.uikitforge.ci"
    compileSdk = 37

    defaultConfig {
        minSdk = 21
    }

    buildFeatures {
        compose = true
    }

    sourceSets.getByName("main").kotlin.directories +=
        layout.projectDirectory.dir("../../ci-artifacts/android-compose/src/main/java").asFile.absolutePath
    sourceSets.getByName("main").res.srcDir(
        layout.projectDirectory.dir("../../ci-artifacts/android-compose/src/main/res")
    )
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2026.08.00")
    implementation(composeBom)
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.ui:ui")
}
