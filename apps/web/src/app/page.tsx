import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="star-bg min-h-screen flex flex-col items-center justify-center px-4 py-12">
      {/* Hero Panel */}
      <div className="neopets-panel max-w-lg w-full text-center space-y-6">
        <h1 className="font-elizapet text-4xl md:text-5xl text-gray-900 drop-shadow-md">
          Welcome to ElizaPets!
        </h1>

        <p className="text-gray-800 text-lg leading-relaxed">
          Create your very own AI-powered pet, explore Neopia Central, and chat
          with the shopkeepers who live there. Your adventure awaits!
        </p>

        <div className="flex flex-col sm:flex-row gap-4 justify-center pt-2">
          <Link
            href="/create-pet"
            className="color-btn bg-neopets-green hover:bg-neopets-green-dark text-center text-lg"
          >
            Create Your Pet
          </Link>

          <Link
            href="/login"
            className="color-btn bg-neopets-blue hover:bg-blue-700 text-center text-lg"
          >
            Login
          </Link>
        </div>
      </div>

      {/* Decorative subtitle */}
      <p className="mt-8 text-neopets-yellow-light font-elizapet text-sm tracking-wide opacity-80">
        An AI-pet adventure inspired by the classics
      </p>
    </div>
  );
}
