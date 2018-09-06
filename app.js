"use strict";
const sacloud = require('sacloud');
const node_ssh = require('node-ssh');
const co = require('co');
const fs = require('fs');
const randomstring = require('randomstring');
const SlackClient = require('@slack/client').WebClient;

const ARCHIVE_ID_CENTOS_7_4_64 = '113000629235'
const SSD_PLAN_ID = 4;
const ZONE_ID = 21001; // 東京第1
const SERVER_PLAN_ID_1CORE_1G = 1001;
const SERVER_PLAN_ID_2CORE_4G = 4002;
const SERVER_PASSWORD = process.env.SERVER_PASSWORD || randomstring.generate(12);
const ECCUBE_REPOSITORY = process.env.ECCUBE_REPOSITORY || 'https://github.com/EC-CUBE/ec-cube.git';
const SLACK_API_TOKEN = process.env.SLACK_API_TOKEN;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL;
const ECCUBE_VERSIONS = [
    '3.0.15', '3.0.16', 'master',
    { name: '4.0-beta', branch: '4.0-beta', path: '/', symfony:true},
    { name: '4.0', branch: '4.0', path: '/', symfony:true}
].reverse();

const client = sacloud.createClient({
    accessToken: process.env.SAKURACLOUD_ACCESS_TOKEN,
    accessTokenSecret: process.env.SAKURACLOUD_ACCESS_TOKEN_SECRET,
    disableLocalizeKeys: false,
    debug: false
});

const zone = "tk1a";
client.opt.apiRoot = `https://secure.sakura.ad.jp/cloud/zone/${zone}/api/cloud/1.1/`;

/**
 * さくらのクラウドAPI呼び出し
 */
function callAPI(request) {
    return new Promise((resolve, reject) => client.createRequest(request).send((err, result) => {
        if (err) {
            console.error('Error', JSON.stringify(request, null, '    '));
            reject(err);
            return;
        }
        resolve(result);
    }));
}

function createSwitch() {
    return callAPI({
        method: 'POST',
        path: `/switch`,
        body: {
            Switch: {
                Name: `bench-cube-switch-${Date.now()}`,
                Description: `EC-CUBEベンチマーク用スイッチ ${new Date(Date.now() + 3600000).toLocaleString('ja', {timeZone:'Asia/Tokyo'})}以降削除可`
            }
        }
    }).then(function(data) {
        console.log(`Switch created: ${data.response.switch.id}`);
        return { id: data.response.switch.id };
    });
}

function removeSwitch(sw) {
    return callAPI({
        method: 'DELETE',
        path: `/switch/${sw.id}`
    }).then(function(data) {
        console.log(`Switch removed: ${sw.id}`);
        return data;
    });
}

function createServer(serverName, serverPlan, sw) {
    return callAPI({
        method : 'POST',
        path : 'server',
        body : {
            Server: {
                Zone : { ID: ZONE_ID },
                ServerPlan : { ID: serverPlan },
                Name : serverName,
                Description: `EC-CUBEベンチマーク用サーバ ${new Date(Date.now() + 3600000).toLocaleString('ja', {timeZone:'Asia/Tokyo'})}以降削除可`,
                ConnectedSwitches: [
                    {
                        virtio: true,
                        BandWidthMbps: 100,
                        Scope: 'shared',
                        _operation: 'internet'
                    },
                    { ID : sw.id }
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
    }).then(data => console.log(`Server removed: ${serverId}`)));
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
                Description: `EC-CUBEベンチマーク用サーバのディスク ${new Date(Date.now() + 3600000).toLocaleString('ja', {timeZone:'Asia/Tokyo'})}以降削除可`,
                Connection: 'virtio',
                SizeMB: 20480,
                SourceArchive: {
                    ID: ARCHIVE_ID_CENTOS_7_4_64
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

function execSsh(serverType, ipAddress, commands) {

    const ssh = new node_ssh();

    return new Promise((res, rej) => {
        let retryCount = 3;
        function loop() {
            return new Promise((resolve, reject) => {
                setTimeout(() => ssh.connect({
                    host: ipAddress,
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
                    rej(err);
                }
            })
        }
        loop();
    }).then(function() {
        return co(function* () {
            for (let cmd of commands) {
                console.log(`[${serverType}] $ ${cmd}`);
                yield new Promise((resolve, reject) => {
                    ssh.connection.exec(cmd, (err, stream) => {
                        if (err) {
                            reject(err);
                        } else {
                            stream.on('data', chunk => {
                                chunk.toString().trim().split(/\r?\n/)
                                    .filter(line => line)
                                    .forEach(line => console.log(`[${serverType}] ${line}`))
                            });
                            stream.stderr.on('data', chunk => {
                                chunk.toString().trim().split(/\r?\n/)
                                    .filter(line => line)
                                    .forEach(line => console.error(`[${serverType}] ${line}`))
                            });
                            stream.on('close', (code, signal) => {
                                resolve({ code, signal })
                            });
                        }
                    })
                });
            }
        });
    }).then(function() {
        ssh.dispose();
    }).catch(function() {
        ssh.dispose();
    });
}

function serverUp(serverType, serverPlan, sw) {
    let ts = new Date().getTime();
    let serverName = `bench-${serverType}-${ts}`;

    return function* () {

        let serverId, diskId, data, serverIpAddress;

        try {
            // サーバ作成
            data = yield createServer(serverName, serverPlan, sw);
            serverId = data.response.server.id;

            // ディスク作成
            data = yield createDisk(serverId, serverName);
            diskId = data.response.disk.id;

            // ディスク準備完了待ち
            data = yield waitForDiskAvailable(diskId);

            // ディスク設定変更
            data = yield configureDisk(diskId, serverName);

            // サーバ起動
            data = yield startServer(serverId);
            data = yield waitForServerStatus(serverId, 'up')

            serverIpAddress = data.response.server.interfaces[0].ipAddress;

            let commands = fs.readFileSync(`setup-${serverType}.sh`).toString()
                .split('\n')
                .filter(cmd => (cmd));

            yield execSsh(serverType, serverIpAddress, commands)

            return { id: serverId, name:serverName, ipAddress:serverIpAddress };

        } catch (e) {
            if (serverId) {
                yield co(serverDown(serverId));
            }
            throw e;
        }
    };
}

function wait(seconds) {
    return new Promise((res, rej) => {
        setTimeout(res, seconds * 1000);
    })
}

function serverDown(...serverIdList) {
    return function* () {
        try {
            yield serverIdList.map(serverId => stopServer(serverId));
        } catch (ignore) {}
        yield serverIdList.map(serverId => waitForServerStatus(serverId, 'down'));
        for (let serverId of serverIdList) {
            yield removeServer(serverId);
        }
    }
}

function toFixed(num, length) {
    let n = Math.pow(10, length);
    return Math.round(num * n) / n;
}

function postToSlack(channel, message, opts) {
    if (SLACK_API_TOKEN) {
        let web = new SlackClient(SLACK_API_TOKEN);
        web.chat.postMessage(channel, message, opts);
    }
}

co(function* () {

    let archives = yield callAPI({
        'method': 'GET',
        'path': 'archive'
    })

    let found = archives.response.archives.filter(data => { return data.id == ARCHIVE_ID_CENTOS_7_4_64; });
    if (!found.length) {
        throw new Error(`Archive ID not found.`);
    }

    // スイッチ作成
    let sw = yield createSwitch();

    // サーバセットアップ
    let [abServer, cubeServer] = yield [
        co(serverUp('cube-ab', SERVER_PLAN_ID_2CORE_4G, sw)),
        co(serverUp('cube-php', SERVER_PLAN_ID_1CORE_1G, sw))
    ];

    let ssh = new node_ssh();
    try {
        yield ssh.connect({
            host: abServer.ipAddress,
            username: 'root',
            password: SERVER_PASSWORD
        });

        let results = new Map();
        for (let version of ECCUBE_VERSIONS) {

            version = typeof version === 'object' ? version : { name: version, branch: version, path: '/html/', symfony: false };
            version.dbName = `eccube_${version.name.replace(/[-.]/g, '_')}`;
            let installScrpt = `
                    cd /var/www/html
                    git clone --depth=1 -b ${version.branch} ${ECCUBE_REPOSITORY} ec-cube-${version.name}
                    cd ec-cube-${version.name}
                    psql -U postgres -c "CREATE DATABASE ${version.dbName} WITH OWNER cube3_dev_user;"
                ` + (version.symfony ?
                `
                    echo APP_ENV=prod > .env
                    echo APP_DEBUG=0 >> .env
                    echo ECCUBE_ROOT_URLPATH=/ec-cube-${version.name}${version.path} >> .env
                    echo DATABASE_URL=pgsql://postgres:password@127.0.0.1:5432/${version.dbName} >> .env
                    composer install --dev --no-interaction -o
                    bin/console d:s:d --force
                    bin/console d:s:c
                    bin/console e:f:l
                    chown -R apache: /var/www/html/ec-cube-${version.name}
                ` :
                `
                    export ROOT_URLPATH=/ec-cube-${version.name}${version.path}
                    export ECCUBE_ROOT_URLPATH=/ec-cube-${version.name}${version.path}
                    export DBNAME=${version.dbName}
                    export ECCUBE_DB_DATABASE=${version.dbName}
                    export DBUSER=postgres
                    export ECCUBE_DB_USERNAME=postgres
                    php eccube_install.php pgsql
                    chown -R apache: /var/www/html/ec-cube-${version.name}
                `);

            // EC-CUBEインストール
            yield execSsh('cube-php', cubeServer.ipAddress, [
                `(${installScrpt.replace(/^\s+/mg, '').replace(/\n/g, '; ')})`,
                'systemctl restart httpd'
            ]);

            // ウォームアップ
            yield ssh.execCommand(`ab -n 10 -c 1 http://192.168.0.2/ec-cube-${version.name}${version.path}`);

            // 5回測定
            let count = 5;
            for (let i=0; i<count;) {
                let output = yield ssh.execCommand(`ab -n 100 -c 10 http://192.168.0.2/ec-cube-${version.name}${version.path}`)
                console.log(output.stdout);
                // ERROR/WARNINGの場合はやり直す
                if (output.stdout.match(/^(ERROR|WARNING): /m)) {
                    continue;
                }
                if (!results.has(version.name)) {
                    results.set(version.name, { results: [] });
                }
                results.get(version.name).results.push(parseFloat(output.stdout.match(/^Requests per second: +([0-9.]+).*$/m)[1]));
                i++;
            }
        }

        // 結果表示
        let outputText = '';
        results.forEach((data, branch) => {
            data.mean = toFixed(data.results.reduce((acc, val) => acc += val, 0) / data.results.length, 2);
            data.median = (l => {
                l.sort((l,r) => l - r);
                let i = Math.round(l.length / 2) - 1;
                return l.length % 2 ? l[i] : (l[i] + l[i+1]) / 2
            })([...data.results]);
            data.sd = toFixed(Math.sqrt(data.results.reduce((acc, val) => acc += Math.pow(val - data.mean, 2), 0) / data.results.length), 2);
            outputText += `[${branch}] mean: ${data.mean.toFixed(2)} [#/ms], median: ${data.median.toFixed(2)} [#/ms], sd: ${data.sd.toFixed(2)} [#/ms], results: ${data.results}\n`
        });
        console.log('#######################################################################');
        console.log(outputText);
        console.log('#######################################################################');
        let chd = 't:0|' + [...results.values()].map((d) => d.mean).join('|');
        let chdl = ' |' + [...results.keys()].join('|');
        let imgUrl = encodeURI(`https://image-charts.com/chart?cht=bhg&chs=400x150&chco=FFFFFF,F56991,FF9F80,FFC48C,D1F2A5,EFFAB4,F0E68C&chd=${chd}&chdl=${chdl}`);
        postToSlack(SLACK_CHANNEL, '```' + outputText + '```', {username:'本日のベンチマーク結果', attachments:[{fallback:outputText,image_url:imgUrl}]});

    } finally {
        ssh.dispose();
        yield co(serverDown(abServer.id, cubeServer.id));
        yield removeSwitch(sw);
    }
}).catch(err => {
    console.log(err);
    process.exit(1);
});