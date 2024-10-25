export type UserType = 'interactive' | 'service'

export abstract class UserBase {
  abstract get userType(): UserType
}
