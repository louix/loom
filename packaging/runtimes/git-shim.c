/* Read-only guest Git client. Host policy validates every argument independently. */
#include <jansson.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int fail(const char *message) { fprintf(stderr, "loom git: %s\n", message); return 128; }
static int write_all(int fd, const char *p, size_t n) {
    while (n) { ssize_t r = write(fd, p, n); if (r < 0 && errno == EINTR) continue;
        if (r <= 0) return -1;
        p += r; n -= (size_t)r;
    }
    return 0;
}
int main(int argc, char **argv) {
    alarm(10);
    int first = 1;
    if (argc > 3 && !strcmp(argv[1], "-C")) {
        if (chdir(argv[2])) return fail("cannot enter requested directory");
        first = 3;
    }
    char cwd[4096];
    if (!getcwd(cwd, sizeof(cwd))) return fail("cannot resolve current directory");
    json_t *args = json_array();
    for (int i = first; i < argc; i++) {
        json_t *arg = json_string(argv[i]);
        if (!arg) return fail("arguments must be UTF-8");
        json_array_append_new(args, arg);
    }
    json_t *request = json_pack("{s:i,s:s,s:s,s:o}", "version", 1, "op", "git", "cwd", cwd, "args", args);
    char *line = json_dumps(request, JSON_COMPACT);
    if (!line || strlen(line) >= 4095) return fail("request exceeds 4 KiB");
    struct sockaddr_un address = {.sun_family = AF_UNIX};
    strcpy(address.sun_path, "/run/loom/git.sock");
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0 || connect(fd, (struct sockaddr *)&address, sizeof(address)))
        return fail("session Git bridge unavailable; this runtime requires a supported linked worktree");
    if (write_all(fd, line, strlen(line)) || write_all(fd, "\n", 1)) return fail("bridge write failed");
    free(line); json_decref(request);
    char *buffer = malloc(512 * 1024);
    if (!buffer) return fail("out of memory");
    size_t used = 0;
    while (used < 512 * 1024) {
        ssize_t n = read(fd, buffer + used, 512 * 1024 - used);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) break;
        used += (size_t)n;
        if (memchr(buffer, '\n', used)) break;
    }
    close(fd);
    json_error_t error;
    json_t *reply = json_loadb(buffer, used, JSON_REJECT_DUPLICATES | JSON_ALLOW_NUL, &error);
    free(buffer);
    if (!reply || json_integer_value(json_object_get(reply, "version")) != 1)
        return fail("invalid or incomplete bridge reply");
    if (!json_is_true(json_object_get(reply, "ok")))
        return fail("command rejected or limit exceeded; supported: read-only status, diff, log, show, branch --show-current and limited rev-parse, at the session root");
    json_t *out = json_object_get(reply, "stdout"), *err = json_object_get(reply, "stderr"), *code = json_object_get(reply, "code");
    if (!json_is_string(out) || !json_is_string(err) || !json_is_integer(code)) return fail("invalid bridge result");
    if (write_all(STDOUT_FILENO, json_string_value(out), json_string_length(out)) ||
        write_all(STDERR_FILENO, json_string_value(err), json_string_length(err))) return 128;
    int status = (int)json_integer_value(code);
    json_decref(reply);
    return status >= 0 && status <= 255 ? status : 128;
}
