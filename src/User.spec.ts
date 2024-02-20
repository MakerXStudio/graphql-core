import type { JwtPayload } from './context'
import { User } from './User'
import { describe, it, expect } from 'vitest'

describe('User', () => {
  it('can understand AzAD B2C claims', () => {
    const b2cClaims = {
      iss: 'https://blah.b2clogin.com/fca17e76-11dc-47d3-8af6-17c1408021bc/v2.0/',
      exp: 1665137208,
      nbf: 1665133608,
      aud: '0e63bc17-ab0b-497b-8df9-a6d7e342ac28',
      sub: '802d0ae4-71ec-4492-a408-f624866715df',
      given_name: 'Hungry',
      emails: ['hungry.hippo@makerx.com.au'],
      tfp: 'B2CPolicy_fake',
      scp: 'API.Scope',
      azp: '9f3f0b67-6006-4d84-818e-ae0d62ffbd9c',
      ver: '1.0',
      iat: 1665133608,
    }
    const user = new User(b2cClaims, '')

    expect(user.id).toMatchInlineSnapshot(`"802d0ae4-71ec-4492-a408-f624866715df"`)
    expect(user.email).toMatchInlineSnapshot(`"hungry.hippo@makerx.com.au"`)
    expect(user.name).toMatchInlineSnapshot(`"Hungry"`)
    expect(user.scopes).toMatchInlineSnapshot(`
      [
        "API.Scope",
      ]
    `)
    expect(user.roles).toMatchInlineSnapshot(`[]`)
  })

  it('can understand standard AzAD claims', () => {
    const claims = {
      aud: 'api://my-api',
      iss: 'https://sts.windows.net/a82d8cd1-a1c6-4002-8131-f39302b79f13/',
      iat: 1665134998,
      nbf: 1665134998,
      exp: 1665140084,
      acr: '1',
      aio: 'AVQAq/8TAAAAFB/O3Maw4yMPFgyEPQuWu/GjEWf8X+emnFNo2LuZ8W1HTaxvYsP8AuJrhvgC4P0zYscduh6ove7iKeyOdHalhwgY7RYAEOLA3FqvmAksFq8=',
      amr: ['pwd', 'mfa'],
      appid: 'd343e7cc-06b2-409f-bbb9-86b996f5efac',
      appidacr: '0',
      family_name: 'Hippo',
      given_name: 'Hungry',
      ipaddr: '27.96.195.162',
      name: 'Hungry Hippo (MakerX)',
      oid: '78f7d812-113a-4c68-9e49-e085b0347769',
      rh: '0.AUIA0YwtqMahAkCBMfOTArefE6CK_Uue8r1Ph-QQwd_55ZpCAHw.',
      scp: 'API.Scope',
      sub: 'QSf5yuai7PUCYJsh2sLOZP5aDQ-TQtHW2Sgsanc5jCY',
      tid: 'a82d8cd1-a1c6-4002-8131-f39302b79f13',
      unique_name: 'hungry@somewhere.onmicrosoft.com',
      upn: 'hungry@somewhere.onmicrosoft.com',
      uti: 'RdaAdPwuVEuhiohkr3g4AA',
      ver: '1.0',
    }

    const user = new User(claims, '')

    expect(user.id).toMatchInlineSnapshot(`"78f7d812-113a-4c68-9e49-e085b0347769"`)
    expect(user.email).toMatchInlineSnapshot(`"hungry@somewhere.onmicrosoft.com"`)
    expect(user.name).toMatchInlineSnapshot(`"Hungry Hippo (MakerX)"`)
    expect(user.scopes).toMatchInlineSnapshot(`
      [
        "API.Scope",
      ]
    `)
    expect(user.roles).toMatchInlineSnapshot(`[]`)
  })

  it('can understand AzAD client credentials claims', () => {
    const claims = {
      iss: 'https://blah.b2clogin.com/fca17e76-11dc-47d3-8af6-17c1408021bc/v2.0/',
      exp: 1665139141,
      nbf: 1665135541,
      aud: 'fd8716c3-2fb3-42e6-be37-bbf461ba976d',
      tfp: 'Tenant_local_dev',
      scp: 'API.Scope',
      azpacr: '1',
      sub: '81ffef74-4998-4a98-900a-b47cc9bc00b9',
      oid: '81ffef74-4998-4a98-900a-b47cc9bc00b9',
      tid: 'fca17e76-11dc-47d3-8af6-17c1408021bc',
      ver: '2.0',
      azp: '70f38028-ad5d-42af-bc60-fd0fe0ab2dca',
      iat: 1665135541,
    }

    const user = new User(claims, '')

    expect(user.id).toMatchInlineSnapshot(`"81ffef74-4998-4a98-900a-b47cc9bc00b9"`)
    expect(user.email).toBeUndefined()
    expect(user.name).toBeUndefined()
    expect(user.scopes).toMatchInlineSnapshot(`
      [
        "API.Scope",
      ]
    `)
    expect(user.roles).toMatchInlineSnapshot(`[]`)
  })

  it('can extend User, e.g. adding user supplied roles', () => {
    class CustomUser extends User {
      private customRoles: string[]
      constructor(claims: JwtPayload, token: string, roles: string[]) {
        super(claims, token)
        this.customRoles = roles
      }
      get roles(): string[] {
        return [...(this.claims.roles ?? []), ...this.customRoles]
      }
    }

    const user = new CustomUser({ roles: ['ClaimRole'] }, '', ['CustomRole'])

    expect(user instanceof User).toBe(true)
    expect(user.roles).toMatchInlineSnapshot(`
      [
        "ClaimRole",
        "CustomRole",
      ]
    `)
  })
})
