const sacloud = require('sacloud');
const node_ssh = require('node-ssh');
const co = require('co');
const fs = require('fs');
const randomstring = require('randomstring');

const ARCHIVE_ID_CENTOS_7_2_64 = '112801122159'
const SSD_PLAN_ID = 4;
const ZONE_ID = 31002; // 石狩第2
const SERVER_PLAN_ID_1CORE_1G = 1001;
const SERVER_PLAN_ID_2CORE_4G = 4002;
const SERVER_PASSWORD = randomstring.generate(12);
const ECCUBE_REPOSITORY = process.env.ECCUBE_REPOSITORY || 'https://github.com/EC-CUBE/ec-cube.git';
const ECCUBE_BRANCH = process.env.ECCUBE_BRANCH || 'master';

const client = sacloud.createClient({
    accessToken: process.env.SAKURACLOUD_ACCESS_TOKEN,
    accessTokenSecret: process.env.SAKURACLOUD_ACCESS_TOKEN_SECRET,
    disableLocalizeKeys: false,
    debug: false
});

/**
 * さくらのクラウドAPI呼び出し
 */
function callAPI(request) {
    return new Promise((resolve, reject) => client.createRequest(request).send((err, result) => {
        if (err) {
            reject(err);
            return;
        }
        resolve(result);
    }));
}

function createServer(serverName, serverPlan) {
    return callAPI({
        method : 'POST',
        path : 'server',
        body : {
            Server: {
                Zone : { ID: ZONE_ID },
                ServerPlan : { ID: serverPlan },
                Name : serverName,
                ConnectedSwitches: [
                    {
                        virtio: true,
                        BandWidthMbps: 100,
                        Scope: 'shared',
                        _operation: 'internet'
                    }
                ]
            }
        }
    }).then(data => {
        console.log(`Server created: ${data.response.server.id}`);
        return data;
    });
}

function removeServer(serverId) {
    return getServer(serverId).then(data => callAPI({
        method: 'DELETE',
        path: `/server/${serverId}`,
        body: {
            WithDisk: data.response.server.disks.map(function(disk) { return disk.id })
        }
    }));
}

function createDisk(serverId, serverName) {
    return callAPI({
        method: 'POST',
        path: 'disk',
        body: {
            Disk: {
                Server: {
                    ID: serverId
                },
                Name: serverName,
                Connection: 'virtio',
                SizeMB: 20480,
                SourceArchive: {
                    ID: ARCHIVE_ID_CENTOS_7_2_64
                },
                Plan: { ID: SSD_PLAN_ID }
            }
        }
    }).then(data => {
        console.log(`Disk created: ${data.response.disk.id}`);
        return data;
    });
}

function waitForServerStatus(serverId, expectStatus) {
    return new Promise((res, rej) => {
        let loop = () => new Promise((resolve, reject) => {
            setTimeout(() => client.createRequest({ method : 'GET', path : `server/${serverId}` }).send((err, data) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(data);
            }), 5000)
        }).then(data => {
            if (data.response.server.instance.status == expectStatus) {
                console.log(`Server ${expectStatus}: ${serverId}`);
                res(data);
            } else {
                console.log(`Waiting for server ${expectStatus}: ${serverId} (${data.response.server.instance.status})`);
                loop();
            }
        });
        loop();
    });
}
function waitForDiskAvailable(diskId) {
    return new Promise((res, rej) => {
        let loop = () => new Promise((resolve, reject) => {
            setTimeout(() => client.createRequest({ method : 'GET', path : `disk/${diskId}` }).send((err, data) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(data);
            }), 5000)
        }).then(data => {
            if (data.response.disk.availability == 'available') {
                console.log(`Disk available: ${diskId}`);
                res(data);
            } else {
                console.log(`Waiting for disk available: ${diskId} (${data.response.disk.availability})`);
                loop();
            }
        });
        loop();
    });
}

function configureDisk(diskId, hostName) {
    return callAPI({
        method : 'PUT',
        path : `disk/${diskId}/config`,
        body : {
            HostName: hostName,
            Password: SERVER_PASSWORD,
        }
    }).then(data => {
        console.log(`Disk configured: ${diskId}`);
        return data;
    });
}

function startServer(serverId) {
    return callAPI({
        method : 'PUT',
        path : `server/${serverId}/power`
    }).then(data => {
        console.log(`Server start: ${serverId}`);
        return data;
    });
}

function stopServer(serverId) {
    return callAPI({
        method : 'DELETE',
        path : `server/${serverId}/power`
    }).then(data => {
        console.log(`Server stop: ${serverId}`);
        return data;
    });
}

function getServer(serverId) {
    return callAPI({
        method : 'GET',
        path : `server/${serverId}`,
    });
}

function serverUp(serverType, serverPlan = SERVER_PLAN_ID_2CORE_4G) {
    let ts = new Date().getTime();
    let serverName = `bench-${serverType}-${ts}`;

    return function* () {

        let serverId, diskId, data, serverIpAddress;

        // サーバ作成
        data = yield createServer(serverName, serverPlan);
        serverId = data.response.server.id;

        // ディスク作成
        data = yield createDisk(serverId, serverName);
        diskId = data.response.disk.id;

        // ディスク準備完了待ち
        data = yield waitForDiskAvailable(diskId);

        // ディスク設定変更
        data = yield configureDisk(diskId, serverName);

        // // サーバ停止
        // data = yield stopServer(serverId);
        // data = yield waitForServerStatus(serverId, 'down')

        // サーバ起動
        data = yield startServer(serverId);
        data = yield waitForServerStatus(serverId, 'up')

        serverIpAddress = data.response.server.interfaces[0].ipAddress;

        const ssh = new node_ssh();

        yield new Promise((res, rej) => {
            let retryCount = 3;
            function loop() {
                return new Promise((resolve, reject) => {
                    setTimeout(() => ssh.connect({
                        host: serverIpAddress,
                        username: 'root',
                        password: SERVER_PASSWORD
                    }).then(function(data) {
                        resolve(data)
                    }).catch(function(err) {
                        reject(err);
                    }), 5000)
                }).then(data => {
                    console.log('Connect succeed.');
                    res(data);
                }).catch(err => {
                    if (--retryCount) {
                        console.log(`Connect fail. retry... [${retryCount}]`);
                        loop();
                    } else {
                        throw err;
                    }
                })
            }
            loop();
        });

        try {
            let commands = fs.readFileSync(`setup-${serverType}.sh`).toString()
                .replace('${ECCUBE_REPOSITORY}', ECCUBE_REPOSITORY)
                .replace('${ECCUBE_BRANCH}', ECCUBE_BRANCH)
                .split('\n')
                .filter(cmd => (cmd));
            for (let cmd of commands) {
                console.log(`${serverType}|$ ${cmd}`);
                let result = yield ssh.execCommand(cmd);
                if (result.code) {
                    throw new Error(result.stderr);
                }
                if (result.stdout) {
                    console.log(result.stdout.replace(/^/mg, `${serverType}|`));
                }
            }
        } finally {
            ssh.dispose();
        }

        return { id: serverId, name:serverName, ipAddress:serverIpAddress };
    };
}

function serverDown(serverId) {
    return function* () {
        yield stopServer(serverId);
        yield waitForServerStatus(serverId, 'down');
        yield removeServer(serverId);
    }
}

co(function* () {

    let [abServer, cubeServer] = yield [
        co(serverUp('cube-ab')),
        co(serverUp('cube-php', SERVER_PLAN_ID_1CORE_1G))
    ];

    let ssh = new node_ssh();
    try {
        yield ssh.connect({
            host: abServer.ipAddress,
            username: 'root',
            password: SERVER_PASSWORD
        });
        let total = 0, count = 5;
        for (let i=0; i<count; i++) {
            let output = yield ssh.execCommand(`ab -n 100 -c 10 http://${cubeServer.ipAddress}/ec-cube/html/`)
            console.log(output.stdout);
            total += parseFloat(output.stdout.match(/^Requests per second: +([0-9.]+).*$/m)[1])
        }
        console.log(`##### Average ${(total / count).toFixed(2)} [#/sec] #####`);
    } finally {
        ssh.dispose();
        yield [
            co(serverDown(abServer.id)),
            co(serverDown(cubeServer.id))
        ];
    }
});
