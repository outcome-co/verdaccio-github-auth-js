import { Octokit } from '@octokit/rest'
import pkg from '../package.json'
import dotenv from 'dotenv'

dotenv.config()

const urlPattern = /^https:\/\/github.com\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/?$/

const parseUrl = () => {
    const match = urlPattern.exec(pkg.repository.url)

    if (match && match !== undefined) {
        // We can cast, as we know the values are defined in the pattern matched
        return {
            org: <string> match.groups?.owner,
            repo: <string> match.groups?.repo
        }
    } else {
        throw new Error('Unable to parse URL')
    }
}

export const { org, repo } = parseUrl()

export const getClient = (): Octokit => {
    const token = process.env.GITHUB_TOKEN

    if (!token) {
        throw Error('Missing GITHUB_TOKEN environment variable')
    }

    return new Octokit({ auth: token })
}
