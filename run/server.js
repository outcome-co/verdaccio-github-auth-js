const startVerdaccio = require('verdaccio')
const { parseConfigFile } = require('verdaccio/build/lib/utils')

const path = require('path')

const configFile = path.join(__dirname, 'config', 'config.yaml')
const parsedConfig = parseConfigFile(configFile)

startVerdaccio.default(parsedConfig, null, configFile, '1.0.0', 'verdaccio',
    (webServer, addr, pkgName, pkgVersion) => {
        webServer.listen(addr.port || addr.path, addr.host, () => {
            console.log(`verdaccio listening on ${addr.host}:${addr.port}`)
        })
    }
)
