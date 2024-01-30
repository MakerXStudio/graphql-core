import type { JwtPayload } from './context'
import { isNotNil } from './utils'

export class User {
  public readonly token: string
  public readonly claims: JwtPayload

  constructor(claims: JwtPayload, accessToken: string) {
    this.claims = claims
    this.token = accessToken
  }

  get email(): string | undefined {
    return (
      this.claims.email ??
      (this.claims.emails as string[] | undefined)?.[0] ??
      this.claims.preferred_username ??
      this.claims.unique_name ??
      this.claims.upn
    )
  }

  get name(): string | undefined {
    if (this.claims.name) return this.claims.name
    const otherNames = [this.claims.given_name, this.claims.family_name].filter(isNotNil)
    if (otherNames.length > 0) return otherNames.join(' ')
    return undefined
  }

  get id(): string {
    return this.firstOrThrow('oid', 'sub')
  }

  get scopes(): string[] {
    return this.claims.scp ? this.claims.scp.split(' ') : []
  }

  get roles(): string[] {
    return this.claims.roles ?? []
  }

  private first(...claims: Array<keyof JwtPayload>): string | undefined {
    for (const key of claims) {
      if (this.claims[key]) return this.claims[key] as string
    }
    return undefined
  }

  private firstOrThrow(...claims: Array<keyof JwtPayload>): string {
    const first = this.first(...claims)
    if (!first) throw new Error(`claims do not include any of: ${claims.join(', ')}`)
    return first
  }
}
