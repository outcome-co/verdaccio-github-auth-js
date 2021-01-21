import sodium from 'tweetsodium'
import { Octokit } from '@octokit/rest'
import pkg from '../package.json'
import yargs from 'yargs'
import Listr, { ListrTask } from 'listr'

import { org, repo, getClient } from './lib'

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

const sync = () => {
    console.log(`Syncing secrets to ${org}:${repo}`)

    const client = getClient()

    return getPublicKey(client, org, repo).then((keyData) => {
        const tasks: ListrTask[] = secrets.map(secretVar => ({
            title: secretVar,
            task: () => storeSecret(client, org, repo, keyData.data.key, keyData.data.key_id, secretVar, <string> process.env[secretVar])
        }))

        const runner = new Listr(tasks, { concurrent: true })

        return runner.run()
    })
}

const clear = function () {
    console.log(`Clearing secrets from ${org}:${repo}`)

    const client = getClient()

    const tasks: ListrTask[] = secrets.map(secretVar => ({
        title: secretVar,
        task: () => client.actions.deleteRepoSecret({
            owner: org,
            repo,
            secret_name: secretVar
        })
    }))

    const runner = new Listr(tasks, { concurrent: true })

    return runner.run()
}

const getPublicKey = function (client: Octokit, org: string, repo: string) {
    return client.actions.getRepoPublicKey({
        owner: org,
        repo
    })
}

const storeSecret = function (client: Octokit, org: string, repo: string, key: string, keyId: string, name: string, value: string) {
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
yargs
    .usage('Usage: $0 <command>')
    .demandCommand(1)
    .version(pkg.version)
    // eslint-disable-next-line no-void
    .command('sync', `Create or update the secrets on ${org}:${repo}`, {}, () => { void sync() })
    // eslint-disable-next-line no-void
    .command('clear', `Clear the secrets from ${org}:${repo}`, {}, () => { void clear() })
    .argv
