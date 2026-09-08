/* Test-only client for a bounded line request over AF_UNIX or AF_VSOCK. */
#include <sys/socket.h>
#include <sys/un.h>
#include <linux/vm_sockets.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int write_all(int fd, const char *data, size_t size) {
    while (size) {
        ssize_t written = write(fd, data, size);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) return -1;
        data += written;
        size -= (size_t)written;
    }
    return 0;
}

int main(int argc, char **argv) {
    if (argc != 4 || strlen(argv[3]) > 4096) return 2;
    alarm(5);
    int fd = -1;
    int result = -1;
    if (!strcmp(argv[1], "unix")) {
        struct sockaddr_un address = {.sun_family = AF_UNIX};
        if (strlen(argv[2]) >= sizeof(address.sun_path)) return 2;
        strcpy(address.sun_path, argv[2]);
        fd = socket(AF_UNIX, SOCK_STREAM, 0);
        if (fd >= 0) result = connect(fd, (struct sockaddr *)&address, sizeof(address));
    } else if (!strcmp(argv[1], "vsock")) {
        char *end;
        unsigned long port = strtoul(argv[2], &end, 10);
        if (!argv[2][0] || *end || port > 0xffffffffUL) return 2;
        struct sockaddr_vm address = {
            .svm_family = AF_VSOCK, .svm_cid = VMADDR_CID_HOST, .svm_port = (unsigned)port
        };
        fd = socket(AF_VSOCK, SOCK_STREAM, 0);
        if (fd >= 0) result = connect(fd, (struct sockaddr *)&address, sizeof(address));
    } else return 2;
    if (result < 0) { perror("connect"); if (fd >= 0) close(fd); return 3; }
    if (write_all(fd, argv[3], strlen(argv[3])) || write_all(fd, "\n", 1)) {
        close(fd); return 4;
    }
    char buffer[8192];
    size_t used = 0;
    while (used < sizeof(buffer)) {
        ssize_t received = read(fd, buffer + used, sizeof(buffer) - used);
        if (received < 0 && errno == EINTR) continue;
        if (received <= 0) break;
        used += (size_t)received;
        if (memchr(buffer, '\n', used)) break;
    }
    close(fd);
    if (!used || !memchr(buffer, '\n', used)) return 5;
    return fwrite(buffer, 1, used, stdout) == used ? 0 : 6;
}
