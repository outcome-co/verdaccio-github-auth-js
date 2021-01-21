import Mustache from 'mustache'
import * as z from 'zod'
import { every } from 'lodash'
import { map, mapValues, reduce, some, includes, filter } from 'lodash'
import { RepositoryPermission } from '../schemaTypes'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Infer<T extends z.ZodType<any, z.ZodTypeDef, any>> = z.infer<T>

const namedObjectSchema = z.object({
    name: z.string()
})

enum UserTypes {
    $ADMIN_USER = '$ADMIN_USER',
    $MEMBER_USER = '$MEMBER_USER'
}

const validUsers = z.nativeEnum(UserTypes)

const userSchema = z.object({
    name: validUsers
})

const repositoryRoleSchema = z.nativeEnum(RepositoryPermission)

const collaboratorSchema = userSchema.extend({
    role: repositoryRoleSchema
})

const metaSchema = z.object({
    package: z.string()
})

const repositorySchema = namedObjectSchema.extend({
    files: z.record(z.string()).default({}),
    meta: metaSchema.optional(),
    collaborators: z.array(collaboratorSchema).default([])
})

const teamRepositoryAccessSchema = namedObjectSchema.extend({
    role: repositoryRoleSchema
})

const teamSchema = namedObjectSchema.extend({
    members: z.array(validUsers).default([]),
    repositories: z.array(teamRepositoryAccessSchema).default([])
})

/**
 * Ensure that all of the collaborators are valid users.
 *
 * @param scenario - The scenario to validate.
 * @returns Returns true if valid.
 */
const checkRepositoryCollaborators = (scenario: ScenarioData): boolean => {
    const userNames = map(scenario.users, u => u.name)

    return every(scenario.repositories, r => {
        const repoUsers = map(r.collaborators, c => c.name)
        return every(repoUsers, u => userNames.includes(u))
    })
}

/**
 * Ensure that all of the team members are valid users.
 *
 * @param scenario - The scenario to validate.
 * @returns Returns true if valid.
 */
const checkTeamMemberships = (scenario: ScenarioData): boolean => {
    const users = map(scenario.users, u => u.name)

    return every(scenario.teams, t => {
        return every(t.members, m => users.includes(m))
    })
}

/**
 * Ensure that all of the team repositories are valid.
 *
 * @param scenario - The scenario to validate.
 * @returns Returns true if valid.
 */
const checkTeamRepositories = (scenario: ScenarioData): boolean => {
    const allRepos = map(scenario.repositories, r => r.name)

    return every(scenario.teams, t => {
        const teamRepos = map(t.repositories, r => r.name)
        return every(teamRepos, r => allRepos.includes(r))
    })
}

const scenarioSchemaWithoutRefinements = namedObjectSchema.extend({
    repositories: z.array(repositorySchema).default([]),
    teams: z.array(teamSchema).default([]),
    users: z.array(userSchema).default([])
})

// This is to avoid a dependency loop, where scenarioSchema depends on checkRepositoryCollaborators
// but checkRepositoryCollaborators depends on ScenarioData, which depends on scenarioSchema
const scenarioSchema = scenarioSchemaWithoutRefinements
    .refine(checkRepositoryCollaborators, { message: 'All repository collaborators must be valid users' })
    .refine(checkTeamMemberships, { message: 'All team members must be valid users' })
    .refine(checkTeamRepositories, { message: 'All team repository memberships must be for valid repositories' })

// Types

type NamedObject = Infer<typeof namedObjectSchema>

type CollaboratorData = Infer<typeof collaboratorSchema>

type RepositoryData = Infer<typeof repositorySchema>

type ScenarioData = Infer<typeof scenarioSchemaWithoutRefinements>

type TeamData = Infer<typeof teamSchema>

type RepositoryRole = Infer<typeof repositoryRoleSchema>

// Wrapper objects

class SessionObject {
    readonly sessionId: string

    constructor(sessionId: string) {
        this.sessionId = sessionId
    }
}

const withSessionId = (name: string, sessionId: string): string => `${name}-${sessionId}`

class NamedSessionObject extends SessionObject {
    readonly data: NamedObject

    constructor(sessionId: string, data: NamedObject) {
        super(sessionId)
        this.data = data
    }

    get name(): string {
        return withSessionId(this.data.name, this.sessionId)
    }
}

class Repository extends NamedSessionObject {
    readonly data!: RepositoryData
    // Little shortcut to replace the name: UserType with name: string
    readonly collaborators: (Omit<CollaboratorData, 'name'> & { name: string })[]

    constructor(sessionId: string, userMap: UserMap, data: RepositoryData) {
        super(sessionId, data)

        this.collaborators = map(data.collaborators, c => ({ ...c, name: userMap[c.name] }))
    }

    get files() {
        return mapValues(this.data.files, fileContent => Mustache.render(fileContent, { sessionId: this.sessionId }))
    }

    get meta() {
        if (!this.data.meta) {
            return undefined
        }
        return mapValues(this.data.meta, value => Mustache.render(value, { sessionId: this.sessionId }))
    }
}

export type UserMap = {
    [K in keyof typeof UserTypes]: string
}

class Team extends NamedSessionObject {
    readonly data!: TeamData
    readonly members: string[]

    constructor(sessionId: string, userMap: UserMap, data: TeamData) {
        super(sessionId, data)

        this.members = map(this.data.members, m => userMap[m])
    }

    get repositories() {
        return map(this.data.repositories, r => ({ ...r, name: withSessionId(r.name, this.sessionId) }))
    }
}

export class Scenario extends NamedSessionObject {
    readonly data!: ScenarioData
    readonly repositories: Repository[]
    readonly teams: Team[]
    readonly users: string[]

    constructor(sessionId: string, userMap: UserMap, data: ScenarioData) {
        super(sessionId, data)

        this.repositories = map(data.repositories, r => new Repository(sessionId, userMap, r))
        this.teams = map(data.teams, t => new Team(sessionId, userMap, t))
        this.users = map(data.users, u => userMap[u.name])
    }

    static parse(sessionId: string, userMap: UserMap, data: unknown): Scenario {
        return new Scenario(sessionId, userMap, scenarioSchema.parse(data))
    }

    repoNames(): Set<string> {
        return new Set(map(this.repositories, r => r.name))
    }

    teamNames(): Set<string> {
        return new Set(map(this.teams, t => t.name))
    }

    packages(): Record<string, string> {
        return reduce(
            this.repositories,
            (packages, repo) => {
                if (repo.meta?.package) {
                    packages[repo.meta.package] = repo.name
                }
                return packages
            },
            <Record<string, string>>{}
        )
    }

    /**
     * Returns the mapping of packages to repositories from the scenario, for
     * the provided user with the given role.
     *
     * @param user - The username.
     * @param role - The user's role.
     * @returns The mapping of packages to repositories from the scenario.
     */
    packagesForUserRole(user: string, role: RepositoryRole): Record<string, string> {
        return reduce(
            this.repositories,
            (packages, repo) => {
                /* istanbul ignore next */
                if (!repo.meta) {
                    return packages
                }

                if (
                    repo.meta.package &&
                    some(repo.collaborators, collaborator => collaborator.name === user && collaborator.role === role)
                ) {
                    packages[repo.meta.package] = repo.name
                }
                return packages
            },
            <Record<string, string>>{}
        )
    }

    /**
     * Returns the packages that do not have any direct
     * collaborators.
     *
     * @returns The mapping of packages to repositories from the scenario.
     */
    packagesWithNoCollaborators(): Record<string, string> {
        return reduce(
            this.repositories,
            (packages, repo) => {
                /* istanbul ignore next */
                if (!repo.meta) {
                    return packages
                }

                if (repo.meta.package && repo.collaborators.length === 0) {
                    packages[repo.meta.package] = repo.name
                }
                return packages
            },
            <Record<string, string>>{}
        )
    }

    packagesForUserTeamRole(user: string, role: RepositoryRole): Record<string, string> {
        const validReposViaTeams = reduce(
            this.teams,
            (repos, team) => {
                /* istanbul ignore else */
                if (includes(team.members, user)) {
                    team.repositories.forEach(repo => {
                        if (repo.role === role) {
                            repos.push(repo.name)
                        }
                    })
                }
                return repos
            },
            <string[]>[]
        )

        return reduce(
            this.repositories,
            (packages, repo) => {
                /* istanbul ignore next */
                if (!repo.meta) {
                    return packages
                }

                if (repo.meta.package && includes(validReposViaTeams, repo.name)) {
                    packages[repo.meta.package] = repo.name
                }
                return packages
            },
            <Record<string, string>>{}
        )
    }

    teamsForUser(user: string): Team[] {
        return filter(this.teams, team => includes(team.members, user))
    }
}
