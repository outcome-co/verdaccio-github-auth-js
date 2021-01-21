import pkg from '../package.json'
import yargs from 'yargs'
import { map } from 'lodash'
import yesno from 'yesno'
import Listr, { ListrTask } from 'listr'

import { getClient } from './lib'
import { Octokit } from '@octokit/rest'
import { TeamsListResponseData, ReposListForOrgResponseData } from '@octokit/types'

const org = 'outcome-co-sandbox'

const clear = async () => {
    console.log(`Clearing fixtures from ${org}`)

    const client = getClient()

    await deleteTeams(client)
    await deleteRepos(client)
}

const deleteTeams = async (client: Octokit): Promise<void> => {
    let allTeams: TeamsListResponseData = []

    await client.paginate(client.teams.list, { org }).then(teams => {
        allTeams = allTeams.concat(teams)
    })

    if (allTeams.length === 0) {
        return
    }

    console.log(`Found the following teams:`)
    allTeams.forEach(t => console.log(`• ${t.name}`))

    if (await yesno({ question: 'Do you want to delete the teams?', defaultValue: false })) {
        const tasks: ListrTask[] = map(allTeams, t => ({
            title: t.name,
            task: () => client.teams.deleteInOrg({ org, team_slug: t.slug })
        }))

        const runner = new Listr(tasks, {
            concurrent: true,
            exitOnError: false
        })

        return runner.run().then(() => Promise.resolve())
    } else {
        console.log('Skipped')
    }
}

const deleteRepos = async (client: Octokit): Promise<void> => {
    let allRepos: ReposListForOrgResponseData = []

    await client.paginate(client.repos.listForOrg, { org }).then(repos => {
        allRepos = allRepos.concat(repos)
    })

    if (allRepos.length === 0) {
        return
    }

    console.log(`Found the following repos:`)
    allRepos.forEach(r => console.log(`• ${r.name}`))

    if (await yesno({ question: 'Do you want to delete the repos?', defaultValue: false })) {
        const tasks: ListrTask[] = map(allRepos, r => ({
            title: r.name,
            task: () => client.repos.delete({ owner: org, repo: r.name })
        }))

        const runner = new Listr(tasks, {
            concurrent: true,
            exitOnError: false
        })

        return runner.run().then(() => Promise.resolve())
    } else {
        console.log('Skipped')
    }
}

// eslint-disable-next-line no-unused-expressions
yargs
    .usage('Usage: $0 <command>')
    .demandCommand(1)
    .version(pkg.version)
    // eslint-disable-next-line no-void
    .command('clear', `Clear the test fixtures from ${org}`, {}, () => { void clear() })
    .argv
