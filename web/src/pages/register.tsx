import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { register } from '@/features/auth/actions'
import { ApiError } from '@/lib/api'
import { useAuth } from '@/stores/auth'
import { AuthLayout } from './auth-layout'

const schema = z.object({
  display_name: z.string().min(1, 'Name is required'),
  email: z.string().min(1, 'Email is required').email('Enter a valid email'),
  password: z.string().min(8, 'At least 8 characters'),
})
type Values = z.infer<typeof schema>

export function RegisterPage() {
  const authed = useAuth((s) => s.accessToken !== null)
  const navigate = useNavigate()
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { display_name: '', email: '', password: '' } })

  if (authed) return <Navigate to="/" replace />

  const onSubmit = async (v: Values) => {
    try {
      await register(v)
      navigate('/', { replace: true })
    } catch (e) {
      form.setError('root', { message: e instanceof ApiError ? e.message : 'Could not reach the server' })
    }
  }

  return (
    <AuthLayout
      title="Create your account"
      subtitle="New accounts start as viewers."
      footer={
        <>
          Already registered?{' '}
          <Link to="/login" className="text-foreground underline-offset-4 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3" noValidate>
          <FormField control={form.control} name="display_name" render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl><Input autoComplete="name" {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
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
              <FormControl><Input type="password" autoComplete="new-password" {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
          {form.formState.errors.root && (
            <p role="alert" className="text-destructive text-xs">{form.formState.errors.root.message}</p>
          )}
          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Creating…' : 'Create account'}
          </Button>
        </form>
      </Form>
    </AuthLayout>
  )
}
