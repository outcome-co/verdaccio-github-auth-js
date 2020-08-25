const sodium = require('tweetsodium')
const { Octokit } = require('@octokit/rest')
const pkg = require('../package.json')

const urlPattern = /^https:\/\/github.com\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/?$/

const parseUrl = function () {
    const match = urlPattern.exec(pkg.repository.url)

    return {
        org: match.groups.owner,
        repo: match.groups.repo
    }
}

const { org, repo } = parseUrl()

require('dotenv').config()

const secrets = [
    'VERDACCIO_TEST_MEMBER_USERNAME',
    'VERDACCIO_TEST_MEMBER_TOKEN',
    'VERDACCIO_TEST_NONMEMBER_USERNAME',
    'VERDACCIO_TEST_NONMEMBER_TOKEN',
    'VERDACCIO_TEST_ADMIN_USERNAME',
    'VERDACCIO_TEST_ADMIN_TOKEN',
    'VERDACCIO_TEST_ORGANIZATION',
    'VERDACCIO_TEST_TOKEN',
    'VERDACCIO_TEST_ADDITIONAL_ADMINS'
]

const getClient = function () {
    const token = process.env.GITHUB_TOKEN

    if (!token) {
        throw Error('Missing GITHUB_TOKEN environment variable')
    }

    return new Octokit({ auth: token })
}

const sync = function () {
    console.log(`Syncing secrets to ${org}:${repo}`)

    const client = getClient()

    return getPublicKey(client, org, repo).then((keyData) => {
        return Promise.all(secrets.map((secretVar) => {
            const value = process.env[secretVar]
            return storeSecret(client, org, repo, keyData.data.key, keyData.data.key_id, secretVar, value).then(() => {
                console.log(`Created secret ${secretVar}`)
            })
        }))
    })
}

const clear = function () {
    console.log(`Clearing secrets from ${org}:${repo}`)

    const client = getClient()

    return Promise.all(secrets.map((secretVar) => {
        return client.actions.deleteRepoSecret({
            owner: org,
            repo,
            secret_name: secretVar
        }).then(() => {
            console.log(`Cleared ${secretVar}`)
        })
    }))
}

const getPublicKey = function (client, org, repo) {
    return client.actions.getRepoPublicKey({
        owner: org,
        repo
    })
}

const storeSecret = function (client, org, repo, key, keyId, name, value) {
    return new Promise((resolve, reject) => {
        try {
            // Convert the message and key to Uint8Array's (Buffer implements that interface)
            const messageBytes = Buffer.from(value)
            const keyBytes = Buffer.from(key, 'base64')

            // Encrypt using LibSodium
            const encryptedBytes = sodium.seal(messageBytes, keyBytes)

            // Base64 the encrypted secret
            const encrypted = Buffer.from(encryptedBytes).toString('base64')

            const response = client.actions.createOrUpdateRepoSecret({
                owner: org,
                repo,
                secret_name: name,
                encrypted_value: encrypted,
                key_id: keyId
            })

            resolve(response)
        } catch (err) {
            reject(err)
        }
    })
}

// eslint-disable-next-line no-unused-expressions
require('yargs')
    .usage('Usage: $0 <command>')
    .demandCommand(1)
    .version(pkg.version)
    .command('sync', `Create or update the secrets on ${org}:${repo}`, {}, () => sync())
    .command('clear', `Clear the secrets from ${org}:${repo}`, {}, () => clear())
    .argv
