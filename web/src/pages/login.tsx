import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { login } from '@/features/auth/actions'
import { ApiError } from '@/lib/api'
import { useAuth } from '@/stores/auth'
import { AuthLayout } from './auth-layout'

const schema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
})
type Values = z.infer<typeof schema>

export function LoginPage() {
  const authed = useAuth((s) => s.accessToken !== null)
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? '/'
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { email: '', password: '' } })

  if (authed) return <Navigate to={from} replace />

  const onSubmit = async (v: Values) => {
    try {
      await login(v)
      navigate(from, { replace: true })
    } catch (e) {
      form.setError('root', { message: e instanceof ApiError ? e.message : 'Could not reach the server' })
    }
  }

  return (
    <AuthLayout
      title="Sign in to Cameraman"
      subtitle="Monitor cameras and automate detections."
      footer={
        <>
          No account?{' '}
          <Link to="/register" className="text-foreground underline-offset-4 hover:underline">
            Register
          </Link>
        </>
      }
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3" noValidate>
          <FormField control={form.control} name="email" render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl><Input type="email" autoComplete="email" {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
          <FormField control={form.control} name="password" render={({ field }) => (
            <FormItem>
              <FormLabel>Password</FormLabel>
              <FormControl><Input type="password" autoComplete="current-password" {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
          {form.formState.errors.root && (
            <p role="alert" className="text-destructive text-xs">{form.formState.errors.root.message}</p>
          )}
          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </Form>
    </AuthLayout>
  )
}
