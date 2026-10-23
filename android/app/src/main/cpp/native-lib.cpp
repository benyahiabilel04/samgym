// جسر JNI لتشغيل Node.js (nodejs-mobile) داخل التطبيق
#include <jni.h>
#include <android/log.h>
#include <pthread.h>
#include <unistd.h>
#include <cstdlib>
#include <cstring>
#include "node.h"

static int pfd[2];
static pthread_t logThread;
static void* logLoop(void*) {
    char buf[2048]; ssize_t n;
    while ((n = read(pfd[0], buf, sizeof(buf) - 1)) > 0) {
        if (buf[n - 1] == '\n') --n;
        buf[n] = 0;
        __android_log_write(ANDROID_LOG_INFO, "SAMGYM-NODE", buf);
    }
    return nullptr;
}
static void redirectStdio() {
    setvbuf(stdout, nullptr, _IONBF, 0);
    setvbuf(stderr, nullptr, _IONBF, 0);
    pipe(pfd);
    dup2(pfd[1], 1);
    dup2(pfd[1], 2);
    pthread_create(&logThread, nullptr, logLoop, nullptr);
    pthread_detach(logThread);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_samgym_app_NodeBridge_startNode(JNIEnv* env, jclass, jobjectArray arguments) {
    jsize argc = env->GetArrayLength(arguments);
    size_t total = 0;
    for (jsize i = 0; i < argc; i++) {
        jstring s = (jstring)env->GetObjectArrayElement(arguments, i);
        total += strlen(env->GetStringUTFChars(s, nullptr)) + 1;
    }
    // Node يتطلب أن تكون الوسائط في ذاكرة متجاورة
    char* buffer = (char*)calloc(total, sizeof(char));
    char** argv = (char**)calloc(argc + 1, sizeof(char*));
    char* cur = buffer;
    for (jsize i = 0; i < argc; i++) {
        jstring s = (jstring)env->GetObjectArrayElement(arguments, i);
        const char* c = env->GetStringUTFChars(s, nullptr);
        strcpy(cur, c);
        argv[i] = cur;
        cur += strlen(c) + 1;
    }
    redirectStdio();
    return jint(node::Start(argc, argv));
}
