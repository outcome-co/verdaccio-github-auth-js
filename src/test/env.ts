import dotenv from 'dotenv'

dotenv.config()

type Maybe<T> = T | void

const isDefined = <T>(x: Maybe<T>): x is T => {
    return x !== undefined && x !== null
}

const ensureEnv = (key: string): string => {
    const val = process.env[key]
    /* istanbul ignore else */
    if (isDefined<string>(val)) {
        return val
    }

    /* istanbul ignore next */
    throw new Error(`${key} is undefined`)
}

export const token = ensureEnv('VERDACCIO_TEST_TOKEN')
export const org = ensureEnv('VERDACCIO_TEST_ORGANIZATION')

export const memberUsername = ensureEnv('VERDACCIO_TEST_MEMBER_USERNAME')
export const memberToken = ensureEnv('VERDACCIO_TEST_MEMBER_TOKEN')
export const adminUsername = ensureEnv('VERDACCIO_TEST_ADMIN_USERNAME')
export const nonMemberUsername = ensureEnv('VERDACCIO_TEST_NONMEMBER_USERNAME')

export const userMap = {
    $MEMBER_USER: memberUsername,
    $ADMIN_USER: adminUsername
}

export const insideGithubActions = process.env.GITHUB_ACTIONS === 'true'
