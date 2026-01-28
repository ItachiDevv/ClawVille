import type { User, Session } from 'lucia';

export interface AppContext {
  Variables: {
    user: User | null;
    session: Session | null;
  };
}

export interface AuthenticatedContext {
  Variables: {
    user: User;
    session: Session;
  };
}
