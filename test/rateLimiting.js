import { withRateLimiting as _withRateLimiting } from '../src/rateLimiting'
import { RateLimiter } from 'limiter'
import { insideGithubActions } from './env'

let limiter
let rateLimitingWrapper

if (insideGithubActions) {
    console.log('Using rate limiting')
    limiter = new RateLimiter(2, 'second')

    rateLimitingWrapper = (fn) => _withRateLimiting(limiter, fn)
} else {
    console.log('Not using rate limiting')
    rateLimitingWrapper = (fn) => fn()
}

export const withRateLimiting = rateLimitingWrapper
export const rateLimiter = limiter
